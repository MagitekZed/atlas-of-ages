# Dynasties (chunk 9)

Family trees for the ruling houses, heirs several deep, marriages that join crowns through real
people, and regalia and other treasures with histories. From the Deep Dive (chunk 9): family
trees (4), the line of succession (4), the royal kinship web (4), named artifacts (4). Needs
chunk 4's character for heirs' natures and chunk 7's inheritance law.

## Goals and non-goals

- **A house is a family.** A ruler has parents, brothers and sisters, a spouse who came from
  somewhere, children born and lost, nephews and cousins. They are kept, not invented at the
  funeral, and the ruler's dossier shows them.
- **The line of succession is real.** Heirs several deep, ordered by the realm's law (chunk 7):
  the eldest and their line, the eldest of the house, two heirs under divided inheritance, the
  great choosing among the royal blood. A child heir has a real regent (the mother, an uncle).
- **Crises have faces.** A pretender is someone in the tree: an ambitious uncle over a child
  king, a younger brother, a bastard, a cousin abroad. The Chronicle names the claim.
- **Crowns join through people.** A royal match marries two real people; their children stand
  in both lines. When a house dies out, the line passes to whoever is next in blood, perhaps a
  foreign prince: a union of crowns, or a war over a cousin's throne.
- **Treasures with histories.** Crowns, swords, seals and relics with a maker, owners and a
  story: forged at a coronation, seized in a sack, carried into exile, lost in a ruin, found
  again centuries later.
- **Not in this chunk:** families for every notable (generals and great people keep their single
  records; only ruling houses and courts in exile get trees), noble houses below the crown
  (the great estate stays a class, chunk 7), how peoples regard each other (chunk 8).

## What exists today

- **Rulers** (`civ/rulers.js`): a person with id, name, gender (a third are women), birth,
  traits, temperament and skills (chunk 4), body, ambitions; death by age, illness, battle,
  assassination; succession by heir, kin, council, election or coup; crises that end in a
  usurper's new house or a war of succession (`successionCrisis`).
- **Heirs and spouses** (`civ/dynasty.js`): `ruler.heir` is one record `{ name, gender, born,
  relation }`, made when the ruler is crowned or later; `ruler.spouse` a name and where they came
  from. With no heir, 60 % of the time "kin" is made on the spot (a brother, nephew or cousin
  with a random relation), else a crisis may come.
- **Houses:** `civ.dynasty` is a name; a house's record goes to `sys.civ.dynasties` (cap 400)
  when it loses the throne; the Legends page for a house shows its rulers as a ladder.
- **Marriages and claims:** a royal match (`arrangeMarriage`, also a Hand power) adds 0.35 / 0.2
  to each crown's claim on the other, fading 2 % a year. A claim of 0.5 lets a crown inherit a
  realm whose ruler dies without an heir (a personal union, which later merges or breaks
  apart); 0.4 is a cause for war. Claims fade below 0.5 within a year of the match, so unions
  by inheritance are rare (one in six test worlds).
- **Regencies, exiles, restorations:** a child ruler gets a regent of a random kind; a fallen
  house may flee into exile (cap 24) and come back.
- **Heir plots** (chunk 4, `ambitions.js`): an ambitious, dishonest heir may seize the throne.
- **Treasures today:** none as objects. Saints' relics are a timed effect on a town (Mythic
  folklore); ruins remember their buildings and wonders; digs find lost knowledge.

## Rule: societies vary

| Rule | Ext point | Default |
|---|---|---|
| Who inherits first, by sex and birth | `heirRule` | see Decisions |
| Which house a child belongs to | `houseRule` | the father's (lizardfolk: the mother's brood) |
| How many children, how often, how many die young | `royalBirths` | by age of the mother, era and the people's lifespan |
| Whether children out of wedlock form a class of their own | `bastardRule` | see Decisions |
| Whom a royal may marry (faith, people) | `matchRule` | the same faith preferred; another people rarely, except allies |
| What treasures a people makes, and what they do | `artifactKinds` | crowns, swords, seals, relics; Mythic peoples' own (see Decisions) |

Proposed Mythic defaults: elves elect (chunk 7), live long and have few children; dwarven
holds pass to the eldest of the clan and forge the most treasures (runeblades, rune-crowns);
orc warlords' strongest child inherits (war skill first); halflings' eldest child, either sex;
lizardfolk broods choose their lords, and a hatchling belongs to its egg-mother's brood.

## Data

- **The kin** — `sys.kin = { p: { [id]: person }, h: { [house]: [living ids] } }`. A person:
  `{ id, n, g, b, d?, f?, m?, h, c, sp: [ids], ch: [ids], bas?, leg? }`: name, sex, born, died,
  father, mother, house, the realm they were born to, spouses, children, a bastard, legitimised.
  The ruler record stays where it is (`civ.ruler`, same id); the kin record holds the links.
  Temperament and skills are made at first read as today, so only those who matter cost more.
- **Who is kept:** the living members of each ruling house and of courts in exile (the ruler,
  spouse, children, brothers and sisters and their children, uncles, aunts and cousins: three
  steps from the ruler), married-in spouses, and the dead who link them (parents, grandparents).
  A yearly prune drops the dead no living member descends from, except rulers (who are in the
  realm's history anyway). Cap: about 40 living a house, a few thousand people in all.
- **The line** — worked out when needed (a death, a dossier) and cached until the family changes.
  `ruler.heir` keeps today's shape, filled from the first in line, so the code that reads it
  (heir plots, the Hand's previews, the dossier) keeps working.
- **Treasures** — `sys.art = [{ id, name, k, made, by, for, at: { k, id }, h: [[day, what, who]],
  pw? }]`: kind (crown, sword, sceptre, seal, ring, relic, book, banner; Mythic kinds), when
  made, by whom (a smith, a people, a figure), for which realm, where it is now (a realm's
  treasury, a person, a ruin, a holy site, lost), up to eight lines of history, a power
  (Mythic). Cap about 300 a world.

## Mechanics

### Family trees

- **Births:** each married couple in a house, yearly at the realm's own month, may have a child
  (the mother 16 to 45 by her people's years, more often young, fewer in later eras); some die
  young, more in early ages and hungry or plague years. Twins are rare.
- **Deaths:** the kin age and die as rulers do (age, illness by their people and seat; the ruler
  and leading princes also in battle); a mother may die in childbed.
- **Marriages:** grown children marry: most to nobles of their own realm (a spouse with a name,
  not followed further), some to other houses through royal matches (the kinship web).
- **Names** follow the house: a son is often named for a grandfather or a past king, as today.
- **Old saves:** on its first yearly pass, a realm's tree is seeded from what exists: the ruler,
  spouse and heir, a few brothers and sisters, and parents linked from the realm's history where
  the relation says son or daughter.

### The line of succession

Read from the tree by the realm's inheritance law and `heirRule`:

- **Eldest:** the ruler's children in order (by the heir rule), each followed by their own line;
  then the ruler's brothers and sisters and their lines; then uncles and cousins.
- **Seniority:** the eldest grown member of the house.
- **Divided:** as eldest, and the next heir takes the split-off realm (chunk 7). With no second
  heir there is no split, which is how it should be.
- **Elective:** the great choose among grown kin of the royal blood (by skill, age and how they
  stand with the great estate), or one of their own when the blood fails.
- **A child first in line** is crowned under a regent from the tree: the mother, else the
  eldest uncle, else a chancellor.
- **Fitness** (shown in the line): a child, a ruler of the wrong sex for the law, a bastard, a
  foreigner, the mad or sickly are weaker heirs; an able, ambitious, grown kinsman behind a weak
  one is a danger.

### Crises and pretenders

- Crisis odds come from the line, not a flat roll: no one in line, a weak first heir with a
  strong rival behind, or a disputed law (divided, elective) raise them; a grown, able heir
  lowers them.
- The pretender is a person from the tree (or a bastard, or a foreign cousin); the war of
  succession is fought for them and the Chronicle names the claim ("her uncle, Duke Arven,
  claimed the throne for himself"). If the line is empty, a usurper's new house as today.
- Today's heir plots (chunk 4) cover the heir and also younger brothers and uncles.

### Bastards (see Decisions)

- A ruler of low honour may father children out of wedlock; they are kept like the others,
  marked. Outside the line unless legitimised (a ruler with no lawful heir may do it), they are
  ready pretenders and may found houses of their own.

### The royal kinship web

- A royal match (`arrangeMarriage`, the Hand's power) marries two real people: the unwed ruler,
  heir or a prince or princess of each house. The spouse moves to the other court.
- Their children belong to the father's house (by `houseRule`) and stand in the mother's
  house's line after its own members: a cousin abroad.
- **Claims come from the line:** a realm whose ruler or heir stands in another realm's line
  holds a claim on it as long as that person lives, stronger the nearer the head of the line.
  `civ.claims` stays, worked out from the tree each year (the 2 % fade goes), so war causes and
  unions keep reading it.
- **When the line passes abroad** (see Decisions): the foreign prince inherits, in a personal
  union with their own crown when they already rule one, or the great refuse them and crown one
  of their own, which can start a war over the cousin's throne.
- Sister realms from a partition share a house, so when one line dies out the other's ruler is
  near in blood: they can come back together through inheritance.

### Named treasures

- **Regalia:** a realm forges a crown (and sometimes a sword of state or a seal) when it first
  becomes a kingdom or empire, or when a great ruler is crowned; named for the realm, the house
  or its maker ("the Iron Crown of Vask"). Kept in the capital. Holding its own regalia steadies
  a crown's legitimacy at each coronation; a usurper without them is weaker.
- **Lost and taken:** when a capital falls, the conqueror may carry the regalia off (prestige for
  them, a grievance and a lost legitimacy for the loser; returning them can be a peace term), or
  they are lost in the sack and lie in the ruin. A court in exile carries its regalia and takes
  them home at a restoration.
- **Blades and heirlooms:** a great general or hero may carry a named sword; it passes to an
  heir, is buried with them, or is lost in battle.
- **Relics:** each faith's holy relics are kept in its holy city; a holy war can seize them;
  Mythic saints' relics become treasures too.
- **Found again:** looting and digs in ruins (`events/ruins.js`) can turn up a lost treasure;
  its old realm or house wants it back.
- **Mythic peoples' own treasures** (see Decisions): dwarven runeblades and rune-crowns, elven
  starglass and leafcrowns, orc war-totems, lizardfolk egg-stones, halfling heirloom books.

## Events and heat

New Chronicle entries (most at importance 1–2, 3 for the great realms):

- an heir is born, a royal child dies young, twins; a royal wedding names both people
- a regency names the mother or uncle; a regency ends
- the line passes to a brother, an uncle, a cousin, a daughter: told with the relation
- a pretender rises (named, with the claim); a bastard is legitimised; a bastard founds a house
- the crown passes abroad: a union by inheritance, or the foreign heir refused
- a war over a cousin's throne
- regalia forged, carried off, lost in a sack, carried into exile, brought home, found in a
  ruin; a named sword passes, is buried, is lost; relics seized in a holy war

The event engine's realm deck reads the tree: succession scandals, royal feuds between brothers.

## Interface

- **The ruler's dossier:** Family (parents, spouse(s), children, brothers and sisters, each a
  link), the Line of succession (the first five, with age and what weakens them), and the
  regalia worn.
- **A person's record:** any kin member opens like a ruler: their place in the tree, their line,
  their nature and skills when read.
- **A house's page** (Legends, exists): a family tree, generations as rows, rulers marked, with
  branches abroad.
- **A treasure's record:** what it is, who made it, where it is now, and its history; a Legends
  list of treasures, known and lost.
- **Map:** none new.

## Saves, keyframes and old worlds

Plain JSON. A dead person's record is closed once dead (nothing edits it after; the keyframe
check enforces that), and a treasure's history only grows by appending. Old saves seed their
trees on the first yearly pass (above) and forge no regalia retroactively except for realms
already kingdoms or empires, which get theirs at the next coronation.

## Performance

Budget 1 ms a simulated year for the chunk's own code. The yearly family pass touches about
20 living kin a house: a few thousand small updates a year. The line is a walk of a few dozen
records, worked out on a death or when a dossier asks, and cached. Treasures change only when
something happens to them. Save size: aim under +3 % (about 100 bytes a kept person).

## Gates (health checks, not targets)

- Most hereditary successions go to a named member of the tree; "kin made up on the spot" is
  gone.
- Crises come with named pretenders; usurpers' new houses still happen when lines fail.
- Unions of crowns by inheritance happen a few times a world per thousand years; sister realms
  sometimes reunite.
- Houses neither die out everywhere nor swell: living kin per house mostly 5 to 30.
- Realm count does not rise; wars of succession may.

## Build order

A. Family trees: the kin store, births, deaths, marriages at home, old-save seeding,
   `ruler.heir` filled from the tree.
B. The line of succession: by law and heir rule, regents from the tree, crises and pretenders
   from the tree, bastards.
C. The royal kinship web: matches between real people, lines across houses, claims from the
   line, inheritance abroad, unions and wars over a cousin's throne.
D. Named treasures: regalia, blades, relics, Mythic treasures; taken, lost, found; the peace
   term.
E. Interface: the ruler's family and line, person records, the house tree, treasure records and
   the Legends list.
F. Gates, the twelve worlds, speed and save size.

## Decisions (2026-10-27)

- **Who inherits first: by people and age.** Historical realms put sons before daughters until
  the later ages (era 5 on: the eldest child, either sex). Mythic peoples have their own rule:
  halflings the eldest child, orcs the strongest grown child (war skill first), lizardfolk broods
  through the mother; elves and dwarves keep their chunk 7 laws (elective, seniority).
- **Bastards, as pretenders.** Rulers of low honour father bastards; outside the line unless
  legitimised (a ruler with no lawful heir may), ready pretenders in a crisis, and they may found
  houses of their own.
- **A foreign heir inherits.** When the next in blood is a prince of another realm, they usually
  take the crown (a personal union if they already rule one, which may merge later); sometimes
  the great refuse and crown one of their own, which can start a war over the cousin's throne.
  Sister realms from a split can reunite this way.
- **Treasures: all of them, Mythic ones with powers.** Regalia, named swords and faiths' relics
  everywhere; each Mythic people's own treasures (dwarven runeblades, elven starglass, orc
  war-totems, lizardfolk egg-stones, halfling heirloom books), with real powers for whoever
  holds them.
