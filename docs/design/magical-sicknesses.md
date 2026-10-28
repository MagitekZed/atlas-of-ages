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
