# Magical sicknesses (chunk 12)

Three sicknesses that only a Mythic world knows: **the grave-plague**, a dark art's weapon;
**mana-burn**, the price of drawing more magic than the land holds; and **the Wasting**, a ruler's
cursed wound that the land shares. From talks with the user (2026-10-28), after chunk 11. Builds
on chunk 11's plagues by people, chunk 4's rulers, chunk 7's court, chunk 8's minorities, chunk
9's heirs and treasures, the arcane arts and the restless dead, all live. Historical worlds are
untouched.

## Goals and non-goals

- **A weapon with a price.** A realm that knows Necromancy, under a cruel ruler and losing a war,
  can lay a grave-plague on an enemy city. Its dead rise bound to the caster and fight for it, so
  the art can turn a war. The price is the world's horror and its own people's fear, and the
  plague itself, which travels like any other and can come home.
- **Magic costs something.** Where a realm draws more magic than its land holds, mana-burn breaks
  out among those who work it: mages, healers, elves. It holds back the realms whose magic runs
  furthest ahead, and it flares again late, as the weave of the world frays.
- **A sickness of the land that no one understands.** A ruler takes a cursed wound and the
  harvests fail around them, year after year, spreading out from their seat. The realm blames
  what it already hates until a seer, a prophet, a healer or the ruler's own confession reveals
  the cause. What it does then depends on the ruler and the court: stepping down, a search for a
  cure, enduring, or murder, and murder is not a clean cure.
- **The player sees the truth.** The Inspector shows the real cause beside what the realm
  believes ("its people blame the Orsk; the true cause is the queen's wound").
- **Not in this chunk:** new kinds of people (seers are a realm's scrying and healers, not named
  figures); wild-magic surges and rifts beyond mana-burn; the dead besieging towns (a bound host
  raids and joins battles, it does not besiege).

## What exists today

- **Necromancy** (`myth/arcana.js`): a dark school with one art (era 2, `necromancy` +0.25,
  military +0.1, stability −0.04). Only a realm under a cruel or mad ruler, or one of little
  tolerance (< 0.32), can learn it, and an art once known is kept. It adds up to +18 % in battle,
  and every realm that does not practise it thinks up to 20 worse of one that does. Nothing yet
  raises the dead in war.
- **The restless dead** (`bands/kinds/undead.js`): great battles and razed cities leave graves;
  decades later a grave may rise as a host (power ∝ dead^0.8, capped at 0.4 % of the world's
  people) that marches on the nearest living town of any realm, grows by its kills and fades after
  three months without. `rise(world, site, {mul})` raises one. A band can carry an employer
  (`band.civId`): hired companies fight as armies, tamed beasts add half their power to their
  master's strongest army, and a dragon's patron is spared while its enemies are favoured.
- **Plagues** (`geo/disease.js`, `geo/health.js`): `createPlague(world, s, cause, opts)` with any
  cause word; each people of a town catches and dies of a plague by its frailty (by race in
  Mythic towns), but nothing yet lets a plague strike one kind of people and spare others.
  `plagueRoom` keeps plagues from crowding each other.
- **Mana and the weave** (`myth/mana.js`, `myth/fading.js`): mana on every tile, drained by the
  arts a town's realm knows and its mages, filled by moonwells; each realm's school, arts and
  research (`civ.arcane`); the magical trades in each town (mages, healers, artificers,
  beast-keepers). The weave (`sys.myth.weave`, 0.15–1) thins with industry and scales mana. The
  wild-magic setting exists but nothing reads it yet.
- **Rulers** (`civ/rulers.js`, `core/character.js`): a body (wounds, a lasting illness, madness),
  six temperament numbers (ambition, mercy, piety, greed, honour, boldness), the hand's curse and
  blessing. A lasting illness called "the wasting sickness" already exists. There is no
  abdication.
- **Heirs and murder** (`civ/ambitions.js`, `civ/rulers.js`): heirs' and kinsmen's plots to seize
  the throne (legitimacy capped at 0.42 after), coups by the court's factions, assassinations.
  Nothing marks a kinslayer; the folklore deck's "cursed house" reads violent deaths in a line.
- **Blame** (`geo/folk.js`, `events/`): hard times push a realm to persecute its minorities, and a
  pogrom can follow in restless towns; plague panic heats blame in a town, which leads to
  persecution of minority faiths; Legendary worlds have witch hunts in plague and famine.
- **Treasures of power** (`civ/treasures.js`): each elder people forges its own (military,
  research, births, happiness); none heals. They are taken with a fallen capital.
- **Gods** (`myth/divine.js`) answer sieges, famines and plagues; none reveals a hidden cause.
- **War**: causes can be added through ext `casusBelli`, and `startWarNamed` takes several
  attackers, but there is no league against a hated realm.

## Rule: societies vary

| Rule | Ext point | Default |
|---|---|---|
| Who would lay a grave-plague | `darkArtRule` (new) | a realm that knows Necromancy, a ruler of little mercy (or cruel or mad), a faith that does not forbid it (healing faiths do), a desperate war |
| How touched by magic each people and trade is | `magicFrailty` (new) | see mana-burn |
| What a people blames for hard times | `blameRule` (new) | what it already hates: its least-liked minority, mages, a hated neighbour, a rival faith, the gods |
| How a realm meets a cursed ruler | `reckonRule` (new) | by the ruler's temperament, the realm's laws and its court |

## Mechanics

### 1. The grave-plague

- **Who casts it.** Once a year, a realm that passes `darkArtRule` and is losing a war: the war
  score well against it, its own towns besieged or taken, or its own siege stalled a year or
  more. The chance grows with how badly it is losing, the ruler's cruelty and the art's strength.
  At most one grave-plague in the world at a time.
- **On whom.** An enemy town in reach: the city it is besieging, the city besieging it, or the
  enemy's greatest town near the front. A grave-plague (cause 'grave', names like the Gravecall,
  the Corpse-Fever, the Grey Death) breaks out there, deadly and fast. It is a plague like any
  other: it spreads by roads, trade and armies, to friend and foe, including the caster's own
  army in the siege lines.
- **The dead rise.** Its dead do not stay buried. Once they pass a threshold, the stricken city
  becomes a grave that rises within months as a host of the dead (the undead band's power rule),
  **bound** to the caster: it marches only on the war's enemy towns and armies (the dragon
  pact's targeting), and when it meets the caster's army in battle it fights beside it (as a
  tamed beast does). Its raids break the enemy's walls for the caster's sieges, and the enemy's
  towns near the stricken city give up sooner in fear (ext `surrenderRule`).
- **The binding breaks** when the caster's ruler dies, when the war ends, or after a few years.
  The host is then an ordinary restless host: it marches on the nearest living town, whoever
  holds it.
- **The price.**
  - Abroad: every realm that hears of it (those that have met the caster) thinks much worse of it
    for about a century; faiths that tend the sick may call a holy war against it; and realms
    that border the caster or its victim, and hate it, may band together in a league war against
    it (a new war cause, `startWarNamed` with several attackers).
  - At home: its people fear it. Stability falls for a generation, its clergy are angered (a new
    estate grievance), the towns near the stricken city grow restless, and a rising can follow.
- **Told:** the casting, the rising, battles the bound dead join, the binding breaking, the league.

### 2. Mana-burn

- **Strain.** Once a year in each Mythic town: how much magic is drawn there (its mages and
  healers, the arts its realm knows, a mage tower) against what its land holds (the tile's mana ×
  the weave). A town drawing more than its land holds is strained. Cities of the great arcane
  realms strain first; a realm on poor mana that works much magic strains everywhere.
- **Outbreak.** A strained town may break out with mana-burn (cause 'mana', names like the
  Witchfire, the Silver Fever, the Unweaving), more often the harder it strains, scaled by the
  wild-magic setting (its first use), and subject to `plagueRoom`.
- **Whom it strikes.** A plague kind carries its own weights per people and trade (ext
  `magicFrailty`), so mana-burn spreads among the magic-touched and barely touches the rest (see
  the decisions). Its dead are taken from the mages and healers first, so the realm's arcane
  research falls behind, and a people's rare art is lost if the town that works it loses its
  mages. The land around the town is burnt: its mana stays low for a generation.
- **Cures.** Physicians, customs and quarantines do nothing for it. Healers, the healing arts
  (Moonweaving, Hearth-craft), wards and the gods ease it.
- **Late in the age.** As the weave thins, every town's land holds less, so the realms that still
  work much magic strain again, worst near the smoke of industry. The magical peoples blame the
  realms whose smoke is fraying the weave (opinion).
- **Told:** the outbreak and why ("drew more than the land could give"), a lost art, the burnt
  land.

### 3. The Wasting

- **The wound.** A ruler is struck by one of:
  - a necromancer's curse: a dark realm at war, with no city to strike, curses the enemy's ruler;
  - a beast's wound: a ruler wounded in battle against a dragon or a host of the dead, or by a
    dragon's raid on their seat;
  - a broken oath: betraying an ally, or breaking a truce or a peace pact;
  - desecration: razing a holy city, or a town on a ley node.

  Each is a small chance. The ruler bears a wound that will not heal (a new lasting illness,
  "a wound that will not close"), and the Wasting begins a year or two later, so the link is not
  plain. In Mythic worlds the old "wasting sickness" is called a consumption, so the two are
  never confused, and plague names skip "Wasting".
- **The land fails.** The towns of the realm grow less food (a settlement effect on food yield),
  worse each year, starting at the ruler's seat and spreading outward a few tiles a year, up to
  about half the harvest. Famine, hunger risings and migration follow through the systems that
  already exist. The wound itself does not kill: the ruler lives on, as long as they would have.
- **The cause is hidden.** Each year the realm blames something (`blameRule`), told in the
  Chronicle:
  - a minority: its standing hardens and pogroms come more readily;
  - the mages: a witch hunt; mages flee or die, and arcane research slows;
  - a hated neighbour, "who poisoned our fields": opinion falls, and a new war cause;
  - a rival faith, or the realm's own gods: persecution, or the state faith loses its fervour.
- **The revelation.** A yearly chance that the cause comes out, raised by the realm's scrying,
  a prophet of its faith, healers in its towns, a great scholar or hero of the realm, and a god
  of secrets, fate or the harvest answering. An honest ruler who comes to suspect it confesses. A
  proud or greedy ruler may learn it first and hide it: they silence the seers (the mages are
  purged), and when it does come out, the court exposes it and their legitimacy falls hard.
- **The reckoning** (`reckonRule`), each year once it is known:
  - **Step down** (merciful, honourable rulers; elective crowns most readily): a new kind of
    succession, abdication. The old ruler lives on in retirement and the wound goes with them, so
    the land heals.
  - **Seek a cure** (pious or bold rulers): a healer of a healing art at home or in a friendly
    realm; a pilgrimage to the faith's holy city or a ley node; a healing treasure (elves, and
    healing faiths, can now forge one), and a war to seize one from a neighbour who holds it (a
    new war cause).
  - **Endure** (ambitious, stubborn, cruel rulers): the court's factions demand they step down
    (a new demand), the estates grow angry, and a coup or rising becomes likelier.
  - **Murder:** heirs' and kinsmen's plots and the factions' coups come far more readily while the
    Wasting is known. The land heals, but the killer bears guilt (see the decisions).
  - A natural death ends it as well.
- **Flight.** A ruler driven out who flees abroad carries the wound with them, and the land of
  the realm that shelters them withers too, more lightly; so realms refuse to shelter them.
- **After.** The land heals over a few years, not at once. The region keeps it in legend (a
  pinned historic site, "the Wasted Land of …").
- **Told:** each year's blame, the revelation (or the ruler hiding it), the reckoning, the cure,
  the healing.

### 4. The Scourge (phase 5, from talks with the user after the first build)

A grave-plague's host can, very rarely, grow into an undead scourge that ruins a whole region.

- **Its potential**, fixed when it rises: the caster's art (its Necromancy, arcana and the magic
  in the land where it rose; the hand counts as a master at high virulence) × the dead to hand
  (the plague's own toll, and the unrisen graves of battles and razed cities within 20 tiles).
  Most hosts have little; their ceiling stays the ordinary one (0.4 % of the world's people).
  One with great potential may grow up to several times that.
- **Growth, if unchecked.** A host with potential does not fade while it kills at least once a
  season; every town it overruns feeds it more of its dead, and the graves it passes rise into it.
- **The Scourge.** Past about 1 % of the world's people, having overrun a few towns, it takes a
  name ("the Scourge of …", told as a world event), breaks free of its maker (see the decisions)
  and blights the land around its path (harvests fail, people flee).
- **The world answers.** Realms in its reach count it their common foe; the threatened realms
  hunt it together (their armies' strength summed against it, where today one realm must be 1.5
  times a band's strength to hunt it alone), and a grand alliance against it is told.
- **The darkness.** If the Scourge lives a generation (about 25 years) and destroys enough towns,
  or a realm, an age of darkness falls on its region: every realm whose seat lies within it
  sinks into a dark age, its land is blighted and its people flee, until some years after the
  Scourge's end. Told as an epochal event.
- **Its end**: armies grind it down; a hero destroys it; its heart is cleansed (an army that
  reaches the plague-pits where it rose, while it is away, burns them, and it fades again); or it
  burns out after a year without new dead.
- **Rarity:** a Scourge in about one Mythic world in ten over a thousand years; an age of
  darkness in about one in forty.

## Interface

- **A plague's account:** its kind (grave-plague, mana-burn), who cast a grave-plague and the host
  it raised, the mages it took.
- **Town dossier, Health:** the town's magical strain among the reasons for its health; a town
  of the Wasting, how much of its harvest is lost.
- **A ruler:** the wound, its cause and since when; whether the realm knows.
- **A realm:** the Wasting, how far it has spread, what its people blame, the cure it seeks, and
  the true cause; a grave-caster's league.
- **A band:** a bound host, whom it serves and until when.

## Phases

1. **The grave-plague:** the casting, the plague kind, the bound host, the price, the binding
   breaking.
2. **Mana-burn:** strain, plague kinds with their own weights, the mages' deaths and lost arts,
   the burnt land, the late flare.
3. **The Wasting:** wounds, the failing land, blame, revelation, reckoning (abdication, cures,
   guilt), flight, healing.
4. **The hand, interface and calibration:** the hand's options, then six Mythic worlds against main to Year 1000, plus forced cases
   that make each sickness happen early, to watch it play out; Historical worlds must stay
   identical to main.
5. **The Scourge:** potential, growth, the Scourge, the common hunt, the darkness, its end;
   then calibration again.

## Speed budget

Under 0.5 ms per sim-year. Strain is one sum per Mythic town a year; the grave-plague and the
Wasting are yearly checks per realm, and only realms at war or with a wounded ruler do any work.

## Calibration targets

In a Mythic world over a thousand years: a grave-plague once or twice (some worlds never, since
Necromancy is rare), mana-burn two to four times (mostly in the great arcane realms), the Wasting
once or twice. Mythic population, realms and wars stay close to main (within a few per cent);
Historical worlds are unchanged.

## Decisions (the user's, 2026-10-28)

- **The grave-plague can turn a war.** The bound dead are a real host for a season and the
  stricken city is crippled, enough to save a losing war. The price is heavy: shunned for about a
  century, often a league war against the caster, unrest at home, and the plague may come home.
- **Mana-burn strikes mages, then elves.** Mages and healers of every people die hardest; of the
  races, elves most, dwarves and lizardfolk somewhat; men, halflings and orcs barely, apart from
  their mages.
- **Killing a ruler of the Wasting leaves guilt, and sometimes more.** The land heals, but the
  killer's legitimacy stays low for their reign and their house gets a cursed name; if the killer
  is kin, about one time in three the land is wounded again, more lightly.
- **The hand can bring them, through existing powers.** In Mythic worlds Curse Ruler can lay the
  Wasting, and the Plague power can choose a grave-plague or mana-burn.

### The Scourge (the user's, 2026-10-28)

- **Control: usually free.** A necromancer strong enough can keep its Scourge (until it outgrows
  them or their ruler dies), but most Scourges break free.
- **Its end: armies, a company of heroes, or sleep.** The threatened realms' armies can grind it
  down, and a company of heroes can destroy it. With no new dead for a year it goes dormant: it
  sleeps in its barrow and weakens slowly, over a generation, until armies can finish it; fresh
  foes coming near wake it. (Added: a sleeping Scourge's barrow is a known place, and a realm
  strong enough nearby sends an expedition to end it in its sleep.)
- **Rarity:** a Scourge in about one Mythic world in ten, an age of darkness in about one in
  forty.
- **Reach: its region, and the world if it spreads beyond.** The darkness falls on its region;
  an especially powerful Scourge that carries its war beyond its region brings a world age, the
  Age of the Dead.

## As built

All in `sim/myth/sickness.js` (a new system, order 87, Mythic only: its update returns at once
below mythLevel 2 and every provider is neutral), with hooks into `geo/disease.js` (the plague
kinds 'grave' and 'mana': their symptoms, names, strength and chronicle lines; no returns of
them), `geo/health.js` (mana-burn's weights by people, no custom or quarantine against it),
`bands/kinds/undead.js` (graves dug by other modules, a bound host), `civ/rulers.js` (abdication,
a wounded ruler's slower death, a murderer's guilt, "a consumption" for the wasting sickness in
Mythic worlds), `civ/ambitions.js` (plots × 4 against a ruler whose wound is known),
`civ/treasures.js` (healing cups), `civ/arts.js` (a rare art lost to sickness), `civ/power.js`
and `civ/court.js` (the clergy's horror at the dark arts), `geo/diplomacy.js` (a `betrayal`
hook), `geo/terms.js` (aims for the new war causes) and `civ/acts.js` (Curse Ruler's choice);
the Inspector in `ui/views/sickness.js`, plus a bound host's master in `ui/views/band.js`. New
ext points: `darkArtRule`, `magicFrailty`, `blameRule`, `reckonRule`. New records:
`sys.myth.sick` (the raging grave-plague, the dread of each caster, burnt lands, each realm's
Wasting, counts), `civ.flags.grave`, `ruler.flags.wound` / `guilt`, `plague.by` / `risen` /
`band`, `band.data.bound`.

- **The grave-plague.** Once a year in its month, a realm that knows Necromancy, under a cruel or
  mad ruler or one of mercy below 0.3, whose state faith does not tend the sick, weighs its worst
  war: (−score − 15) / 45, + 0.25 for each of its towns besieged half a year. At 0.3 or more it
  lays one at 0.3 × despair × (0.6 + 1.6 × its art) (× 1.3 cruel or mad), at most once in 30
  years a realm and 80 years in the world, and only while no other rages. Its target is the
  greatest enemy town it besieges, else the greatest enemy town of tier 2+ within 35 tiles of its
  seat. The plague is a curse on that city: infectivity 1.3 (× 2.2 in the city itself), lethality
  0.3–0.45 × (1 + the art), 8 % of the city sick at once, and a fifth of a plague's usual time
  before it fades. Once 60 or 3 % of the city have died (a month on), its dead rise as a host (the undead power rule × 1.5) bound to the caster for three years,
  while its ruler lives and it is at war with anyone: it marches only on its master's enemies'
  towns, fades a third as fast, and adds half its power to the caster's armies within ten tiles.
  Then it is an ordinary host. The price: every realm thinks 30 worse of the caster, fading over
  a century; a casus belli 'dread' for forty years (1.3, 1.7 for a healing faith); a league war
  ('league', aim humble) of the neighbours of caster or victim who hate it and are free (each
  0.35 + 0.2 healing faith − opinion/100); stability −0.06 for 25 years; the clergy's anger up to
  −0.3 fading over thirty years; its towns' grievance +0.12 fading over ten.
- **Mana-burn.** Strain = 1 − the town's mana / the target the weave, the setting and the smoke
  set there (mana.js's own relaxation target), 0 on land of almost no magic. Once a year (month
  6) each town with a mage and strain 0.5+ may break out at 0.009 × ((strain − 0.5)/0.5)² × wild
  magic × plagueRoom × √(mages/20) (≤ 2) × how magic-touched its people are (their shares ×
  magicFrailty), at most once in 25 years world-wide. Infectivity at least 1.9, lethality at
  least 0.15–0.3 × strength (≤ 0.5), two-fifths of a plague's usual time. Each people catches it × magicFrailty
  (elves 1, dwarves and lizardfolk 0.4, orcs 0.15, men and halflings 0.12) and dies of it ×
  √magicFrailty, with no custom; no quarantines. Wards (deaths × (1 − ½ wards)) and the healing
  arts (Moonweaving or Hearth-craft: × 0.8) ease it. When it ends, the land of its first town is
  burnt (mana and base × 0.5 in the nine cells around it for 25 years; mages follow mana), and
  each rare art worked in a stricken town is lost at 35 %. The late flare is the weave's: a
  thinner weave lowers every target. Once the weave is below 0.75, realms of elves, dwarves and
  lizardfolk think up to 20 × frailty worse of Industrial realms.
- **The Wasting.** A wound needs 150 years since the last, world-wide (the hand's excepted): a
  desperate dark realm curses its enemy's leader (5 % × despair a year); a betrayal (1.2 %); a
  holy city razed (5 %) or a town on a ley node (3 %); a dragon's raid on a seat (1.2 %) or the
  dead's (0.8 %). The land begins to fail one to two years later: loss +0.07 a year to 0.5 (×
  ½ for a kinslayer's), out to 3 + 4 a year tiles (≤ 40), × (1 − 0.6 d/reach, ≥ 0.4) by distance
  (settlement effect foodYield). A wounded ruler's death hazard is × 0.8. While hidden, the realm
  blames (re-chosen 12 % a year): its least-liked minority (1.4 if disliked, else 0.7;
  persecuted, feelings −6 a year), its mages (0.9; research −6 %), its most hated neighbour
  (1.1; opinion −25, a 'blight' war cause), or its gods (0.5; its faith's fervour −0.04 a year,
  stability −0.03). A proud or greedy ruler (honour < 0.35, ambition or greed > 0.6) may learn it
  first (30 % a year from the second year), silencing the seers (research −8 % for three years).
  Revelation a year: 0.03 + 0.01 a year of the blight (to 15) + 0.3 × scrying + 0.1 × healers + 0.06 a prophet + 0.05 a sage or hero +
  0.06 a god of secrets, fate or the harvest (× 0.4 while hidden by the ruler; + 0.08 for an
  honest ruler's confession from the third year; ≤ 0.6); a ruler who hid it loses 0.2
  legitimacy. Then the reckoning (weights: step down (mercy + honour)/2 − 0.3, × 2 elected; cure
  0.15 + 0.5 × max(piety, boldness); endure 0.1 + 0.5 × max(ambition, 1 − mercy)): stepping down
  happens at 60 % a year; a cure comes from a healing cup held (50 %), lent by a friend (25 %),
  the healing arts (12 %) or a pilgrimage (6 %), or a war for a neighbour's cup (25 %), and after
  six years the realm gives up and endures; enduring costs stability −0.05 and legitimacy −0.03 a
  year, and the great of the realm depose the ruler (a coup) at 0.05 + 0.02 a year known (≤ 0.3);
  plots × 4 throughout. Healing takes the loss down 0.15 a year. A kin murder or a coup
  leaves the new ruler's legitimacy 0.12 lower for the reign; a kinslayer, one time in three, is
  wounded too, the land's loss carried over at 60 %. Healing cups: a third of the elves'
  treasures of power, and 0.2 % a year for a realm of a healing faith without one (health +0.03).
- **The Scourge** (phase 5; also in `bands/kinds/undead.js`, `bands/combat.js`,
  `bands/hunts.js`, `events/data.js` and `events/ages.js` (the Age of the Dead, never rolled at
  random), `civ/stability.js` (a dark age begun by others)). Every risen host gets a potential
  (an `undeadRisen` hook): its maker's art (a caster's Necromancy + ½ arcana; the hand's
  virulence above 0.8; 0.135 for a natural rising) × (½ + the mana where it rose) ×
  log10(the dead to hand / 500), ≤ 2 (its own grave and the unrisen graves within 20 tiles). From
  0.25 it has the makings: a ceiling × (1 + 4 × potential, ≤ 5), 1.44 power a death instead of
  0.9, graves within 4 tiles swallowed, and in battle it is worn down (each defeat 10–50 % of its
  power, each win feeding it 0.6 of the soldiers it kills) instead of felled. It is named the
  Scourge at 0.74 % of the world's people (1.85 × an ordinary host's ceiling) with six towns
  overrun; a master holds it at (art − 0.5) (≤ 60 %) and only while its power stays below
  3 % × art of the world's people, otherwise it breaks free. Named, it reaches 30 tiles, never
  fades, blights the towns within 8 tiles (harvests × 0.7, newcomers × 0.4, happiness −0.1, for
  three years), wastes the land within 2, and the realms with towns within 25 hunt it together
  (their summed strength against 1.5 × its own; each realm's part at least a quarter of it) and
  want war with each other × 0.6; their old quarrels set aside is told once. A lone champion has
  1 % against it (5 % while it sleeps); a company of three to six heroes of the nearest realm
  goes at most every five years (30 %), at 0.3 × √(an ordinary ceiling / its power) (+0.15
  asleep, +0.1 × arcana). A year without new dead and it sleeps where it stands (a barrow on the
  map), losing 0.4 % a month; a grown town within 12 tiles wakes it (6 % a month), or an army
  within 4; a realm near it strong enough sends an expedition. After 25 years named, with 8
  towns or a realm destroyed or 6 % of the world's people dead by it, the darkness falls on 35
  tiles: realms seated there sink into dark ages, its towns' harvests × 0.8, newcomers × 0.6,
  for as long as it lives and fifteen years after. If it then carries its war 10 tiles beyond
  that region, or grows past 1.8 % of the world's people five years on, the Age of the Dead (a
  world age of 40 years: stability and happiness −0.03 on every realm, wars × 0.75).
- **The hand.** The Plague power has a kind in Mythic worlds (a plague, a grave-plague whose dead
  rise masterless, mana-burn), chosen on its card; Curse Ruler asks which curse (madness and
  cruelty, or the Wasting).
- **Not built:** a Scourge that founds a realm of the dead; a fled ruler carrying the wound abroad (rulers driven out leave no court in
  exile to follow), a seer as a named person, and the factions' own demand that a wounded ruler
  step down (the plots and the stability loss stand in for it).

## Results

Twelve Mythic worlds (medium, plus one small) against main to Year 1000, and the six Historical
and Legendary worlds of the usual matrix. Two mains that differ only in one chronicle line's
draw (chunk 11's last commit) drift apart by Year 1000 by ±10–15 % in realms and 17–83 % in
plague deaths, so that is the noise floor for a Mythic comparison.

| Mythic, 12 worlds | Year 500 | Year 1000 |
|---|---|---|
| Population | +4 % | +2 % |
| Realms | +10 % | −4 % |
| Towns | +3 % | +3 % |
| Wars | +6 % | −1 % |
| Plague dead | +252 % (one world's grave-plagues) | +4 % |

- **Historical and Legendary worlds are identical to main** at Years 500 and 1000 (every sampled
  field but the timing), and the determinism check passes.
- **The ages:** the leading realm reaches the Classical Age by Year 1000 in 9 of 12 Mythic worlds
  (main 7).
- **The Wasting:** 22 wounds in 12 worlds (0–3 a world): a beast's wound 10, a broken oath 8, a
  desecration 2, a necromancer's curse 2. Of the 20 that ended, 7 by the great of the realm
  deposing the ruler, 4 by illness, 4 by a cure, 2 by stepping down, 2 of old age, 1 by murder;
  about eight years each on average. In the forced cases the arc runs wound, failing harvests,
  blame (the gods, a neighbour, the mages, a minority), revelation (often a confession), a
  reckoning and the healing.
- **Mana-burn:** 30 outbreaks in 12 worlds (0–6 a world, 2.5 on average), all in the later
  centuries as mages multiply; from a handful of dead to 4,500 in an elven city, and burnt land
  around each first town.
- **The grave-plague:** necromancy stays rare. One world of twelve had a dark realm desperate
  enough, and it laid three (80 years apart): 48,000, 51,000 and 19,000 dead, each raising a host;
  no league formed there (earlier runs had one). Forced on a town at Year 300 it kills 4–14 % of
  its city, reaches four to six towns and is over within the year, and its dead rise.
- **Speed:** the new system costs 0.33 ms per sim-year in a Mythic world (budget 0.5); timeab on
  Year-900 saves of main: Historical +0.2 % (the same simulation), Mythic −3.0 % (the histories
  diverge).
- **Save size:** the new state is about 130 bytes at Year 900.
- **Gates:** all nine pass (npm test, trial-myth, cohort, keyframe, hand, hand-myth, three
  300-year Mythic trials); 19 systems load.

### Lessons

- The first grave-plague was an ordinary plague with a curse's name: four of them killed 0.8 to
  1.4 million each in one world. A curse has to be laid on a city: fierce there, weak beyond,
  and short.
- Mana-burn broke out in human towns with mages, where nobody could catch it. Its outbreaks now
  start where the magic-touched live.
- A hidden cause could stay hidden for half a century, and some Wastings ran 40–55 years with
  nothing happening. Suspicion now grows with the years, and the great of a realm depose a ruler
  who will not go; deposition became the commonest ending.
- Chunk 11's final calibration runs were made before its last commit (which changed a chronicle
  line's draw), so they were not main's numbers; main was rerun for this comparison.
