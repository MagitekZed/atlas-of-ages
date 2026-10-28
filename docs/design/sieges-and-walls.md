# Sieges and walls (chunk 6)

Walls by type and condition against engines and methods, so sieges end by assault, mining,
hunger or treachery. From the Deep Dive (chunk 6): siegecraft (4), walls in detail (4). Needs
chunk 2's engineers and gear.

## Goals and non-goals

- **A town's walls are a thing.** What they are (palisade, stone walls, castle, star fort, or a
  people's own), their towers, gate and moat, the hill or river that guards them, and their
  condition: new, worn, breached, mended. The town's dossier shows them.
- **A siege has a method and an ending.** Starved out and surrendering on terms; stormed through
  a breach the engines made; a mine sprung under the walls; a gate opened by a traitor or bought
  with gold; relieved by an army; abandoned to winter and sickness. The Chronicle says which.
- **The ages show.** Palisades burn; stone walls wait for engines; castles outlast a season;
  cannon bring down medieval walls in weeks until star forts restore the defence.
- **Famous sieges are remembered.** A long, costly or decisive siege is named and kept in the
  town's record and on its siege ground.
- **Not in this chunk:** camp sickness and disease in the lines (chunk 11), sea blockades beyond
  today's harbour rule, fortified lines in the open field.

## What exists today

- **Walls** (`civ/data.js`, `civ/buildings.js`): one building with four levels (palisade, stone
  walls, castle, star fort; the last needs cannon). A town's `defense` (settlement.js) drifts
  toward a target from its tier, its walls level and its realm's defence modifier;
  `damageSettlement` (quakes, eruptions, storms, sacks) knocks it down for a while.
- **Sieges** (`geo/war.js siegeTick`): one army leads each siege, reinforced by the others in the
  lines. A single progress bar fills each day by the besiegers' power (strength × siege modifier
  × skill × morale × engineers, `army.js siegeMul`) against the town's hold (garrison, people,
  defence, capital) × its fort (defence; cannon halve walls below a star fort). Starving towns
  fall faster, a harbour fed from the sea slower; a town may open its gates to a realm it
  remembers kindly (`geo/memory.js`). Full progress is a capture: sacked or razed, as today.
- **Endings recorded:** captured, razed, lifted (the besieger left), broken (relieved by a
  victory); a siege ground (`sim/sites.js`) keeps its outcomes and longest siege; towns count
  their sieges.
- **Relief:** armies march to relieve their realm's besieged towns, and a won battle breaks the
  siege.
- **Mythic:** dwarven stone-binding (walls that mend: +30 % hold); the ext 'siege' multiplier.

## Rule: societies vary

| Rule | Ext point | Default |
|---|---|---|
| What walls a people raises, and their names | `wallKind` | by level: palisade, stone walls, castle, star fort |
| How a people besieges (the methods it favours) | `siegeCraft` | by temperament, era and engineers |
| When a town gives up | `surrenderRule` | a starving town surrenders on terms (see Decisions) |
| What a conqueror does with walls it takes | `slightRule` | keeps them, or tears down those of a town it fears (see Decisions) |

Proposed Mythic forms (see Decisions): dwarven rune-walls that mend (stone-binding), dwarves
mine best and hold to the last; elven thorn-walls that regrow and never burn, elves starve a
town rather than storm it; orc stake-walls, orcs storm and never surrender; lizardfolk causeways
and marsh moats that defeat mines; halfling hedge-banks, halflings surrender readily and are
spared.

## Data

- `s.wall = { c, tw, mo, cit, br }` per walled town (about 40 bytes): condition 0–1, towers 0–4,
  moat (0 none, 1 dug, 2 water: a river, a marsh, the sea), a citadel (a castle's keep or a
  capital's inner fort: a last stand after the walls fall), and a breach 0–1 (a gap not yet
  mended). The type stays `s.buildings.walls`. Natural defences (hill, river, marsh, coast) are
  read from the town's tile, not stored.
- `s.siege` gains `{ br, mine, hun, as, lost, m, bribe }`: the breach made, a mine's progress,
  the town's hunger, assaults made, men lost in them, the method now pressed, gold offered.
  `progress` stays (how near the town is to falling, for the gauge and old saves).
- Famous sieges: on the siege ground (`site.data.famous`, at most four per place) and a world
  list (`sys.war.famous`, cap 200): `{ sid, name, start, end, outcome, how, att, def, dead }`.

## Mechanics

### Walls

- **Strength:** the level's base × condition, plus towers (castles and star forts start with
  them, larger towns add more over the years), a citadel, a moat (against mines and escalade),
  and the ground: a hill or a crag (against engines and mines), a river or the sea on one side.
- **Condition:** new walls stand at 1. Worn by bombardment and mines, brought down in part by
  quakes and eruptions (through `damageSettlement`), burned when they are palisades (a sack, a
  wildfire of the hand), and by neglect when the crown cannot pay their upkeep (chunk 7's purse).
  Mended a little each year while paid; a breach closes in a few years.
- **New walls:** raising the next level resets the condition; a castle comes with towers and a
  citadel; star forts are low and thick (cannon count for little against them).
- **Slighting** (see Decisions): a conqueror may tear down the walls of a town it fears: far from
  its seat, disloyal, of another people, or that cost it a long siege.

### The siege

Each day for the leading army, each month a choice of what to press:

- **Blockade** (always): the town eats its stores (its food, more with a granary); a harbour is
  fed from the sea unless the besieger rules the sea. Hunger weakens the garrison and breaks the
  town's will; a starving town surrenders on terms (see Decisions).
- **Bombardment:** engineers and their engines (rams and towers, then trebuchets, then guns:
  gear tier) wear the walls' condition: palisades burn fast, stone walls slowly until
  trebuchets, anything below a star fort quickly to cannon. A breach opens as condition falls.
- **Mining:** engineers dig toward the walls (not through rock or water: a hill of stone, a moat,
  a marsh); a defender with engineers may countermine. A sprung mine opens a breach at once.
- **Assault:** the commander storms the breach, or (bold, cruel or impatient) escalades without
  one at a heavy price. Odds from the attackers' power against the garrison × walls × towers;
  a repulse costs many men and morale; success takes the town (sacked as today; a citadel may
  hold a few weeks more).
- **Treachery and gold:** each month a gate may open: today's memory of the besieger, a disloyal
  town, a garrison of another people or faith, and the besieger's gold (chunk 7's purse) and
  intrigue (a ruler's or general's). The town is taken without a sack.
- **Sallies:** a strong garrison may sally to burn the engines (the breach and mine set back).
- **Relief** (as today): a relieving army that wins breaks the siege.
- **Giving up:** the besieger lifts the siege when its army wastes away, winter closes in, or the
  war ends.

### Endings and memory

- Endings: **stormed** (sacked), **surrendered** on terms, **betrayed** (a gate opened),
  **mined** (a mine and the storm after it), **relieved**, **lifted** (winter, losses), **held**
  (the war ended first). The capture line says how: "Varn fell after eleven months: the walls
  were mined at the river gate and the breach stormed."
- Surrender spares a town the sack and leaves a kinder memory (`geo/memory.js`); a storming
  leaves the bitterest.
- **Famous sieges:** a siege of over a year, one that cost many thousands, or one that took a
  capital, is named ("the Siege of Varn", "the Great Siege of Varn" for the longest) and kept on
  the siege ground and in the world's list; the Hall of Records' longest siege reads it.

## Events and heat

New Chronicle entries (most at importance 1–2, 3 for the great sieges): the walls breached, a
mine sprung, an assault thrown back (with its dead), a starving town's surrender, a gate betrayed
or bought, a sally that burned the engines, a siege lifted for winter or sickness, a famous
siege's end, walls slighted, walls brought down by a quake. Today's capture lines say how the
town fell.

## Interface

- **The town's dossier:** a Walls section: their kind, condition (and breach), towers, gate,
  moat or water, the ground, a citadel; sieges withstood and lost.
- **The siege gauge** (exists): the method pressed, and the tracks (breach, mine, hunger), the
  assaults made and the men lost.
- **The siege ground's record:** its famous sieges.

## Saves, keyframes and old worlds

Plain JSON on the settlement and the siege. Old saves: walls gain condition 1 and features from
their level, size and tile on the first read; a siege in progress turns its progress into a
breach and hunger. The famous list is append-only.

## Performance

Budget 0.5 ms a simulated year: a few dozen sieges a day at most, a few numbers each; walls
mend in the town's yearly pass.

## Gates (health checks, not targets)

- Sieges end in several ways: storming is no more than half of them; surrender, treachery and
  mines all appear.
- Siege lengths: weeks against a palisade, months against stone walls, a year or more against a
  walled capital; cannon shorten them until star forts.
- War counts and lengths stay about main's.

## Build order

A. Walls in detail: the data, strength, condition, upkeep and mending, quakes, slighting, the
   peoples' walls.
B. Siegecraft: the methods, the endings, the capture lines.
C. Famous sieges.
D. Interface.
E. Gates, the twelve worlds, speed and save size.

## Decisions (2026-10-27)

- **Siege lengths: more spread, a longer longest, not all longer.** A rich, well-fortified town
  with full stores can hold out far longer than today (two or three years for a great walled
  city fed from the sea); a town with little laid by collapses faster than today. So a town's
  stores become a real number: months of food laid by (more with a granary, more in a rich town,
  more in a capital or a town that has seen war coming), eaten through in the siege; the walls'
  strength sets how long engines and assaults take; together they spread sieges out from weeks
  to years.
- **A starving town that surrenders is spared the sack:** no sack or razing, its garrison marches
  out, and it remembers its conqueror less bitterly; a cruel conqueror may still break the terms
  now and then.
- **Slighting: sometimes.** A conqueror may tear down the walls of a town it fears (far from its
  seat, disloyal, of another people, or one that cost it a long siege); most walls are kept.
- **Mythic peoples, each their own:** dwarves build walls that mend, mine best and hold to the
  last; elves grow thorn-walls that regrow and never burn, and starve a town rather than storm
  it; orcs build stake-walls, storm and never surrender; lizardfolk build causeways and marsh
  moats that defeat mines; halflings build hedge-banks, surrender readily and are spared.
