# Inventions that travel — design

Chunk 5 of the deeper-simulation plan (the Deep Dive, "the work in chunks"): **where each invention
was first found, how it spread, which ones only a few peoples ever have, and inventions that
change the world through every system** rather than as a bonus to a number. It grew from the
Deep Dive's single idea (knowledge fronts) in talks with the user (2026-10-26): three tiers of
knowledge, rare arts that realms hoard, and more inventions to use through everything ("things
like the printing press that literally changed the world").

Today a realm knows a set of 48 inventions in eight ages (plus the arcane arts in Mythic worlds),
held by the realm as a whole. Research comes from its people, inventiveness, libraries, golden ages,
scholars and, since chunk 4, its ruler's learning. Ideas cross borders only as a discount: each
neighbour or contact that knows an invention makes it 14 % cheaper (22 % with trade), up to 60 %.
A breakaway realm keeps all its parent knew; a new people gets what 60 % of the living know.
Nothing is ever forgotten, though library towns dig lost arts out of ruins. Most inventions are a
bonus to a few numbers; a handful are read by name (riding for cavalry, gunpowder for gear and
volleys, printing for constitutions and the Age of Learning).

After this change:
- **Every invention has a story.** Who found it first, where and when, and how each realm came by
  it: its own research, trade, a border, conquest, a scholar, refugees, a ruin, the gods.
- **Common, uncommon and rare.** Common knowledge (iron, boats) anyone can invent. Uncommon
  knowledge needs the right land or situation to invent alone (bronze needs copper or tin, steam
  needs coal), and is otherwise learned from those who have it. Rare arts (Greek fire, silk,
  porcelain) are secrets outside the ages: found only by realms that meet their recipe, hoarded in
  one town, carried off by conquest, defection or theft, and lost when their town falls.
- **Knowledge travels by force and by people.** Conquest teaches the conqueror, a beaten army learns
  its enemy's arms, scholars move abroad, refugees bring what their homeland knew.
- **Knowledge can be lost** in a collapse, and found again in libraries' archives and in ruins.
- **More inventions, used through everything.** About two dozen turning points join the tree (the
  plough, the alphabet, roads, paper, the stirrup, the compass, the cannon, the telegraph …), each
  acting through the systems it changed. The printing press, already in the tree, gets its full
  weight: knowledge flies, faiths split, ideas of rule spread.
- **A map of knowledge.** A map mode shows how far an invention has spread; the Chronicle marks
  its notable crossings.

## Goals and non-goals

- **Goals.**
  - Inventions with origins and journeys, told in the Chronicle and on the map.
  - Some knowledge nearly universal, some regional, some held by one or two realms in a world.
  - Wars, migration and great people moving knowledge, so the map of knowledge follows history.
  - Collapse that costs knowledge, and revivals that recover it.
  - Turning-point inventions that act through the systems they changed, not only as bonuses.
- **Non-goals.**
  - Knowledge per town for the common tree (a realm still knows what it knows). Only rare arts and
    archives are kept per town.
  - A tech tree interface rework. The tree view gains tiers and stories; its layout stays.
  - Sieges in depth (chunk 6) and laws of secrecy (chunk 7). The cannon and star forts here use
    today's siege rules.

## Rule: societies vary

| Rule | Default here | Later variations (examples) |
| --- | --- | --- |
| **What a people can invent alone** (`inventRule`, first) | The uncommon inventions' conditions below | Dwarves count ore as always in reach; a seafaring people counts any coast as open sea |
| **How readily a realm learns from others** (`learnRule`, mul) | × 1; isolationist realms less, humans in Mythic worlds more (their existing gift) | A faith that forbids foreign learning; a law that welcomes scholars (chunk 7) |
| **Who keeps secrets** (`secretRule`, first) | Every realm hoards its rare arts | Guild laws that guard them harder; a merchant republic that sells them (chunk 7) |

## Gates

As in chunks 1 to 4:
- `npm test`, `--trial` at myth level 2, the 300-year Mythic trials, the keyframe and cohort checks.
- At mythLevel 0, a world with and without the myth module stays byte-identical.

Calibration across the twelve worlds against main: population, realms, towns, wars, the age each
realm reaches by Years 500 and 1000 (the march of the ages should keep about today's pace unless the
user chooses otherwise), how many realms know each invention, rare arts found and lost.

Speed: at most +1 % per sim-year. Research is monthly per realm as today; the new channels are
events. Save: at most +150 KB at Year 1000.

## Data

### Per realm: how it knows what it knows

`civ.tech.known[id] = day` stays. Beside it, `civ.tech.from[id] = 'h:c'`: how (`r` research, `t`
trade, `b` border, `c` conquest, `a` arms, `s` scholar, `f` refugees, `u` ruins, `d` divine, `i`
inherited, `g` granted at birth) and from which realm. Missing in an old save: research.

### Per invention: its story

`sys.know.first[id] = [civId, sid, day]` (today's `firstTech` keeps the realm only), and
`sys.know.lost[id]` the last loss (realm, day, why). The fronts are read from the realms' `known`
days; nothing more is stored per invention.

### Tiers

Each invention in the tree carries `tier: 'common' | 'uncommon'` and, when uncommon, `needs(w, civ)`:
the condition to invent it alone. Rare arts are a separate list (below).

### Rare arts: `sys.know.rare[artId]`

`{ first: [civId, sid, day], held: [[civId, sid, since]], lost: [[civId, sid, day, why]] }`: each
holder realm practises the art in one town (its workshop, shipyard or kiln). At most a few holders
at once.

### Archives: per town with a library

`s.archive = [ids]`: the inventions written down there, copied from the realm when the library is
built and kept up as it learns (a Great Library keeps everything; a plain library its realm's
newest 12). Lost when the town burns, is razed or sacked; a ruin keeps its archive for the dig.

## Mechanics

### The tiers

**Common.** Anyone may research them as today. Iron, boats, writing, the wheel, law, mathematics,
medicine and most of the tree.

**Uncommon.** A realm without the condition pays **three times** the cost to invent it alone
(decision); learning it from a realm that knows it costs as usual. So bronze spreads from the
mining lands, steam from the coal lands, and an isolated realm without tin may stay in the Stone
Age longer. Never a hard block: a world with no tin still reaches the Iron Age, late.

| Invention | Condition to invent alone |
| --- | --- |
| Bronze Working | copper or tin within reach |
| Horseback Riding, The Chariot | horses within reach |
| Irrigation, The Water Mill | a river or lake in the realm |
| Sailing, The War Galley, Shipbuilding, The Compass | a coast |
| Navigation | a coast on open sea |
| Paper | fibre plants in the realm: forest, rainforest or wetland (bark, hemp, bamboo, papyrus) |
| Banking | a market town of city size |
| Gunpowder | saltpetre: desert, dry shrubland or mountains in the realm; else learned, mostly by war |
| Steam Power, The Factory System | coal within reach |
| Railways | coal and iron within reach |
| Combustion | oil within reach |

**Rare arts.** Outside the tree's ages: they never count toward entering an age, so the march of
the ages keeps its pace. A realm that meets an art's recipe has a small chance each year (about
1 % to 3 %, by art) to find it, at the town the recipe points to. Holders hoard it (below).

| Rare art | Recipe | What it does |
| --- | --- | --- |
| Greek fire | the war galley, oil seeps (oil) within reach, a war at sea | its fleets win at sea; its harbour town holds against sea sieges |
| Crucible steel | iron, iron ore, a trade route from a far realm | its gear is finer (quality +0.1) |
| Silk | weaving, husbandry (the silkworm), warm forest (the mulberry) | trade from its towns worth more; prestige |
| Porcelain | pottery, engineering (kilns hot enough), hills (the white clay) | trade worth more; culture |
| Concrete | engineering, a volcano within reach of its capital | building and walls cheaper and lasting; harbours on open coast |
| Purple dye | fishing, weaving, a warm coast (the sea snail) | trade worth more; the crown's colour, legitimacy |
| Wayfinding | rafts and canoes, the calendar (star lore), many islands, no navigation yet | open-sea settlement in early ages |
| The composite bow | the bow, husbandry (horn and sinew), horseback riding, steppe or savanna | horse archers: its light horse fights as heavy |
| Clockwork of the heavens | astronomy, bronze, a great scholar | research; astronomy; a wonder of the age |
| Fine glass | pottery (kilns), guilds, a coastal trade town (sand and fuel by sea) | trade worth more; the telescope sooner |

These ten are open to every people in both kinds of world.

### Mythic rare arts

The user's model (2026-10-26): one art for each people but humans, two open to any people, and
humans able, rarely, to take any of them. Humans are the "normal" people: their gifts are learning
from others and the mix of peoples in their towns, so their way to the arts is gathering everyone
else's.

**A people's art** is practised only by its own people. A realm holds it through a town where that
people is at least a quarter of the souls (the peoples' mix, chunk 1). A conqueror of that town
holds the art while the people stays; if they leave or dwindle below the share, it is gone for that
realm. Other peoples never learn it any other way (decision 6).

| People | Rare art | Recipe | What it does |
| --- | --- | --- | --- |
| Elves | Ship-singing | Wood-Singing, shipbuilding, old forest on a coast | living ships: fleets faster, never lost to storms |
| Dwarves | Stone-binding | Rune-Carving, masonry, mountains | walls and halls that mend themselves; sieges against them fail more often |
| Orcs | War-beast breeding | Beast-Calling, husbandry, steppe | its war beasts (an army role since chunk 2) fight far harder |
| Halflings | Everkeeping | Bountiful Hearth, pottery, a river | sealed larders: famine hardly touches its towns |
| Lizardfolk | Swamp-physic | Venom Lore, medicine, wetland | fever cures: plague deaths in its towns cut sharply |

**Open arts**, for any people in a Mythic world, hoarded like the Historical ones:

| Rare art | Recipe | What it does |
| --- | --- | --- |
| Dragonbone craft | bronze, dragonbone within reach | armour: losses in battle down |
| Ley-glass | pottery (kilns), a ley node in its lands | lenses that hold mana: arcane research faster |

Starmetal forging is left out (the dwarves' Star-Forging art already is it), and so are wyrmfire and
beast-hide armour.

**Humans** have no art of their own. They find the ten Historical arts at the same odds as anyone,
and steal the open arts as anyone may. Beyond that:
- **A people's art, rarely.** About 0.2 % a year per art when the realm trades with or borders that
  people, five times as much when that people lives in its own towns (its cosmopolitan gift).
- **Practised anywhere.** Once a human realm has learned a people's art it practises it in any of
  its towns, without that people: the one thing no other people can do.

### Hoarding

A rare art does not spread by trade or border. It moves only:
- **By conquest of its town.** The taker learns it (60 %), or its craftsmen flee to a friendly realm
  (25 %), or it dies with them (15 %).
- **By defection.** A master craftsman of the holder may go abroad (0.05 % a year for each realm it
  is in contact with, three times as likely in a dark age, twice under a cruel ruler).
- **By theft.** A rival whose ruler has intrigue (chunk 4) of 0.6 or more may steal it: 0.3 % a year
  × intrigue, half again for a neighbour. Told as smuggling ("monks carried silkworms out in hollow
  canes").
- **By marriage or gift.** A royal marriage or an alliance of long standing, rarely.
- **By reinvention.** Anyone who meets the recipe may find it again on their own, a quarter as
  readily while another realm still holds it. At most three realms hold an art at once.

It is **lost** when no holder remains: its town razed or taken while its craftsmen died, or its
realm fallen. The world remembers that it existed ("the secret of Greek fire was lost"), and a dig
in the ruin of its town may find it again.

### How knowledge travels

Today's discounts for trade and borders stay (the trade discount follows the traffic on the
routes, not just their being open). New channels, each a head start on research (a share of the
invention's cost, so they quicken the spread without handing out knowledge):
- **Conquest.** While a realm holds towns taken from a realm that knows more, each such invention is
  cheaper (up to 30 % by the share of its people in those towns). Rome learning from Greece.
- **The arms race.** A realm beaten in a named battle by an enemy a gear tier above it gains 15 % of
  the enemy's next military invention (as it already copies a plan that beat it).
- **Scholars.** A great scholar may emigrate to a realm with a university or a learned ruler, or
  flee war, a dark age or persecution. The new realm gains a burst toward what the homeland knew.
- **Refugees.** A town that takes in many refugees or migrants from a more learned realm gives its
  realm a head start on one invention they knew.
- **Allies.** An alliance counts as trade for the discount.
- **Mythic arts between peoples.** The arcane arts cross between realms of different peoples at
  half the discount; a people's own school is hard for others to learn. Humans learn them at the
  full rate (their gift of learning from others).

### Losing knowledge

Common and uncommon knowledge is lost only in a **collapse**: a realm that falls to a fifth of its
towns within a generation, enters a dark age after a great defeat, or loses its capital with a
library. Each invention of its newest age, and of the one before at half the rate, may be lost
(20 %), unless an archive in its lands still holds it. Printing makes loss rare (× 0.2). A lost
invention is remembered: relearning it costs half.

Rare arts are lost as under "Hoarding".

### Archives and the burning of libraries

Libraries now keep an archive (see Data). A sacked or razed library town loses it, and the Chronicle
says so ("the Great Library of Varn burned, and with it ..."). A collapsing realm keeps whatever
its surviving archives hold. Digs in ruins (today's excavation) read the ruin's archive instead of
the fallen realm's whole knowledge, so a ruin with a library is worth digging.

### New inventions

About two dozen join the tree (decision 1), three or four an age, chosen for having changed the
world. Each acts through the systems it changed, beside a modest bonus. **Bold**: turning points
with effects in several systems.

| Age | Invention | Needs | Tier | Acts through |
| --- | --- | --- | --- | --- |
| Stone | The Bow | stone tools | common | hunting yield; more bows in its armies |
| Stone | Rafts and Canoes | stone tools | common (water) | fish; river travel; crossings to islands in sight; needed for sailing |
| Stone | Weaving | husbandry | common | storage, trade goods, happiness; needed for silk |
| Bronze | **The Plough** | agriculture, husbandry | common | farm yield; one farmer feeds more, freeing hands for the trades (chunk 1) |
| Bronze | The Calendar | mysticism, agriculture | common | farm yield, festivals, priests' standing in choosing a government |
| Bronze | The Chariot | the wheel, husbandry | uncommon (horses) | a chariot arm before riding; the Age of the Horse Lords |
| Iron | **The Alphabet** | writing | common | research; its knowledge spreads faster to and from it; scholars; reach of rule |
| Iron | **Roads** | masonry, the wheel | common | armies and trade move faster; the reach of rule; risings put down sooner |
| Iron | The War Galley | sailing, bronze | uncommon (coast) | sea battles and raids from the sea; needed for Greek fire |
| Classical | **Paper** | writing, weaving | uncommon (fibre plants) | research; archives keep more; needed for printing; spreads by capture |
| Classical | The Water Mill | engineering, the wheel | uncommon (river) | production; fewer labourers needed |
| Classical | Siege Engines | engineering, mathematics | common | sieges; engineers in its armies |
| Classical | Maps | mathematics | common | reach of settlement and trade; explorers; wars further afield |
| Medieval | **The Stirrup** | horseback, iron | common | heavy horse (knights); the feudal host; the charge |
| Medieval | **The Compass** | iron, sailing | uncommon (coast) | safer seas and longer voyages; needed for navigation |
| Medieval | The Windmill | engineering, weaving (its sails) | common | production; grain in dry lands without rivers |
| Medieval | The Mechanical Clock | guilds, astronomy | common | production, research, a town's pride |
| Medieval | Double-Entry Bookkeeping | mathematics, guilds | common | taxes collected; needed for banking; banking houses thrive |
| Renaissance | **The Cannon** | gunpowder | common | sieges: old walls fall; walls rebuilt as star forts; guns at sea |
| Renaissance | The Telescope | astronomy, guilds | common | research; navigation |
| Renaissance | **The Chartered Company** | banking, navigation | common | trade overseas; colonies; merchant houses |
| Industrial | **The Telegraph** | electricity, railways | common | the reach of rule: far provinces hold together; diplomacy; armies answer faster |
| Industrial | **The Factory System** | steam, guilds | uncommon (coal) | production, industry, labourers to the mills, crowding, pollution, unrest |
| Industrial | The Rifle | chemistry, gunpowder | common | gear; defenders bleed attackers |
| Industrial | The Steamship | steam, navigation | common (coast) | sea range and trade; navies |

### Requirements, reviewed

The user asked (2026-10-26) that every requirement make sense: the first draft had paper needing a
library, when libraries of clay and scroll came long before paper. Reviewed so that each invention
needs what it was really built from, and each condition is a thing of the land:
- **New inventions:** paper needs writing and weaving (pulp from fibre), not the alphabet (paper's
  inventors had none); maps need only mathematics; the compass needs iron and sailing (a lodestone
  needle for steering), not astronomy; the windmill needs engineering and weaving (cloth sails),
  not crop rotation.
- **Uncommon conditions:** paper needs fibre plants (forest, rainforest or wetland), not a library;
  gunpowder needs saltpetre (desert, dry shrubland or mountains), not a university.
- **Rare recipes:** each is materials and know-how, not a mood of the realm: Greek fire needs oil
  seeps (it was naphtha), silk the silkworm and the mulberry, porcelain hot kilns and white clay,
  purple dye the sea snail, glass kilns and a trading coast; golden ages and long peaces are gone
  from the recipes.
- **The existing tree, where it was odd:**
  - Horseback riding needs husbandry (and horses), not the wheel.
  - Crop rotation needs the plough and iron, not irrigation.
  - Gunpowder needs medicine (the alchemists' learning) and guilds, not feudalism.
  - Drama needs writing and mysticism (festival rites), not laws.
  - Astronomy also needs the calendar.
  - The Great Library (a library's second level) needs paper, not printing: Alexandria and the
    House of Wisdom came long before the press.
- **New links:** sailing needs rafts and canoes, printing needs paper, navigation needs the compass,
  banking needs bookkeeping, steam needs the cannon (bored cylinders) rather than gunpowder alone.

### The printing press, in full

Today: research + 30 %, culture, a constitution's pull, the second level of libraries and theatres,
the opera, the Age of Learning. Added:
- **Knowledge flies.** Between realms that print, the spread discounts are half again as large,
  and lost knowledge is rare (× 0.2).
- **Faiths split.** A faith whose realms print is likelier to schism (the Reformation), most of all a
  great multi-realm faith.
- **Ideas of rule spread.** A revolution or reform in a printing realm stirs unrest in its printing
  neighbours.
- **Readers.** Scholars and clergy grow in its towns' trades (chunk 1).

### Turning points by age

How the others in bold act, beyond their bonus:
- **The plough:** the farmer share a town needs falls, so more hands go to the trades.
- **The alphabet:** writing spreads: the alphabet's discount to others is doubled.
- **Roads:** an army's march in its own lands × 1.25; the reach of rule + 2; a rising is less likely
  to break a far province away.
- **Paper:** archives hold twice as much; it is the invention most often carried off by conquest.
- **The stirrup:** heavy horse joins the mix of its armies; a feudal host fields more knights.
- **The compass:** safer crossings (fewer fleets lost) and seaward settlement range + 10.
- **The cannon:** walls below a star fort count for half in a siege; star forts need it.
- **The chartered company:** overseas colonies likelier; banking houses richer.
- **The telegraph:** the reach of rule + 6; a far province revolts and breaks away less.
- **The factory system:** labourers move to factories; crowding and unrest rise with them.

### The map and the Chronicle

- **Knowledge map mode.** Pick an invention: realms shaded by when they learned it (dark early, pale
  late, blank unknown), the first town marked, lines for conquest and scholars. For a rare art, its
  holder towns, and the places it was lost.
- **Notable crossings only.** Today every learning is a Chronicle line of importance 1. Added:
  a line when an invention reaches a new people or a new land mass for the first time, and when it
  is lost or found again. The lines say how ("learning from the Varathi by trade", "taught by the
  scholars who fled Oskel").

## Events and heat

- `tech.reached` (2): an invention reaches a new people or land mass.
- `tech.lost`, `tech.found` (2): lost in a collapse; found again in an archive or a ruin.
- `library.burned` (3 for a Great Library, else 2).
- `art.found` (3), `art.taken`, `art.stolen`, `art.fled` (2), `art.lost` (3).
- `scholar.fled` (2).
Rate-limited like the people news.

## Interface

- **Realm dossier.** Knowledge: inventions by age with how each was learned; rare arts held and
  where; the realm's archives.
- **Town dossier.** Its archive; a rare art's workshop.
- **Invention view** (Legends): first found, by whom and where; the spread over time; holders now.
- **Map mode** "Knowledge" (above).

## Saves, keyframes and old worlds

A realm's `from` and the rare arts are new state. An old save loads with every known invention
counted as its own research, no rare arts, and no archives; archives fill as libraries next update
and rare arts are found from then on.

## Performance

Research is monthly per realm as today; conditions for uncommon inventions are read from the
realm's resources once a year; rare art recipes once a year per realm; the channels are events.
Expected: well under 1 %.

## Build order

One go on `sim/inventions`, a commit per phase, stopping only for the user's decisions:

1. **Stories and tiers.** `from`, first finds, the uncommon conditions, the new channels of spread,
   the Chronicle's notable crossings.
2. **New inventions.** The two dozen, their prerequisites and effects; the printing press in full.
3. **Rare arts.** Recipes, hoarding, theft, defection, loss; the Mythic peoples' arts and the human
   gift.
4. **Loss and archives.** Collapse, archives, burned libraries, digs.
5. **The interface.** Map mode, dossiers, the invention view.
6. **Calibration, speed and gates**, then the Ledger and the Deep Dive.

## Decisions

The user's choices, recorded when made (talks of 2026-10-26):
1. **New inventions: the two dozen**, with every requirement reviewed to make sense (above).
2. **The march of the ages: the same cost to enter an age.** Two inventions of an age, priced as
   today; with more to choose from, realms differ more within an age.
3. **Uncommon inventions without the right land: three times the cost.** Never a hard block.
4. **Turning points: world-shaping.** Printing splits faiths and spreads revolutions, the telegraph
   holds empires together, the cannon brings down old walls, factories crowd towns.

5. **Mythic rare arts: one per people, two open, humans may take any.** Elves ship-singing, dwarves
   stone-binding, orcs war-beast breeding, halflings everkeeping, lizardfolk swamp-physic; open to
   all: dragonbone craft and ley-glass. A people's art lives with its people (a conqueror holds it
   while they stay); humans alone may learn one outright, rarely, and practise it anywhere.
6. **Other peoples never learn a foreign people's art directly**, so the human gift stays theirs.

From the talks before:
- Three tiers: common knowledge anyone may invent (iron, boats); uncommon knowledge that needs the
  right land or situation; rare arts with recipes that realms hoard.
- Losing knowledge: common and uncommon only in a collapse; rare arts far more easily.
- Spread by conquest, the arms race, scholars and refugees, as head starts on research.
- Libraries and archives are part of the chunk.
- Mythic arts cross between peoples slowly; humans learn fastest.
- More inventions that change the world through every system, like the printing press.
