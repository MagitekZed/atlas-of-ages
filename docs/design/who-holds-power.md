# Who holds power (chunk 7)

Classes with wealth, rights and loyalty; a few laws per realm; factions at court with demands;
and the ways a crown loses its money in peace as well as war. From the Deep Dive (chunk 7):
social estates (5), laws (5), court factions (4), a court that spends (5), ruin after revolt (4),
corruption (4), debased coin (4). Needs chunk 1's trades to size the estates.

## Goals and non-goals

- **A realm has an inside.** Who it is made of (its estates), what it allows (its laws), who
  pulls at its ruler (its court), and where its money goes. Its dossier shows all four.
- **Revolts have a class and a cause.** A peasant rising over serfdom and hunger, a noble
  rebellion over a crown that seized their lands, townsmen who want a charter, a clergy that
  calls the faithful against a tolerant king, slaves who break their chains.
- **Realms stop hoarding.** Today the median realm holds 20 to 40 years of income by Year 1000
  (one world: 186), because a realm at peace has almost nothing to spend on. A court that
  spends, corruption, ruin after revolt and debased coin give money ways out in peace too.
- **Laws reshape maps.** Divided inheritance splits realms between heirs; serfdom and slavery
  make an unfree class that can rise; tolerance changes who is content.
- **Not in this chunk:** family trees and royal kinship (chunk 9), how peoples regard each other
  and migrations (chunk 8), prices and goods (coin's debasement stays a level, not a price list).

## What exists today

- **Governments** (`civ/government.js`, `data.js`): twelve, each with a tax rate, a capacity, a
  succession kind and a crisis weight; reforms when a realm outgrows its institutions,
  revolutions when stability collapses (`stability.js revolutionCheck`).
- **Stability** (`stability.js updateStability`): a target from legitimacy, happiness,
  institutions, war, overextension, faith, unrest, debt, losses, size, diversity, hegemony.
- **Towns** (`settlement.js`): happiness and unrest from food, wealth, taxes, war weariness,
  faith, distance, crowding, conquest; risings and secessions (`stability.js rebellionCheck`,
  `revolt`), collapse into civil war.
- **Money** (`civmonth.js`): income = taxes × the ruler's stewardship; expenses = 35 % of income
  (more when overextended) + a little per town + armies (ext 'upkeep'). Above two years of
  income, 8 % a month of the excess pays for town projects, if any town has one. The tax rate
  eases when the treasury is large. Borrowing between crowns and banking houses (`geo/debt.js`).
- **Trades** (`civ/jobs.js`): eleven per town: farmers, herders, fishers, miners, craftsmen,
  merchants, soldiers, clergy, scholars, builders, labourers. No nobles, no unfree.
- **The court today:** only the event engine's 'faction' heat (court intrigue, succession
  scandals in `events/decks/realm.js`) and the ruler's temperament and skills (chunk 4).
- **Laws today, in effect:** the government's succession kind, the way armies are raised
  (`civ.forces.sys`: levy, feudal, standing, hired; chunk 2), a tolerance trait.

## Rule: societies vary

Every "who" is a rule read through a provider with a default, so later work (and Mythic peoples)
can vary it:

| Rule | Ext point | Default |
|---|---|---|
| Which estates a realm has, their names and how they are sized | `estates` | five: the great (nobles), clergy, townsfolk, commoners, the unfree; sized from the trades |
| What each estate wants (rights it expects for its power) | `estateWants` | by estate and era |
| The laws a realm may hold and its starting laws | `lawMenu`, `lawStart` | by government, era and people |
| Who may inherit, and how a realm is divided | `inheritRule` | the law: eldest, divided, elective, seniority |
| Who may be held unfree, and how | `bondRule` | the law: none, serfdom (commoners on the land), slavery (captives of war) |
| The court's factions and what they want | `factions` | army, church, old blood, guilds, reformers |
| What the court spends on | `courtSpend` | by government and ruler |

Mythic peoples get their own forms through these: a dwarven hold's estates might be thanes,
rune-priests, guilds, delvers and thralls; an elven realm's houses, wardens, artisans and kin,
with no unfree at all. (Proposed defaults below; see Decisions.)

## Data

All per realm, saved, small (about 300 bytes a realm):

- `civ.est` — five rows `[share of people, share of wealth, rights 0–1, loyalty 0–1]`, rounded;
  power is read from them (wealth × rights, plus arms for the great), never stored.
- `civ.laws` — `{ inherit, faith, bond, land, since: { law: day } }`. The army's way of raising
  stays `civ.forces.sys` and is shown with the laws.
- `civ.court` — up to five factions `{ k, sway 0–1, lead: { name, since }, want, since }` and
  `lastPurge`.
- `civ.purse` — `{ court (share of income spent on the court), graft (corruption share),
  coin (debasement 0–0.6), ruin (until, share) }`, plus a month's accounts for the dossier.

## Mechanics

### The money drains (the hoarding cure)

Monthly, in the treasury step:

- **A court that spends.** A share of income goes on the court: palaces, feasts, favourites,
  display (see Decisions for the reserve). The share is the government's base (tribe 5 %, monarchy and feudal 12 %, empire 18 %,
  dictatorship 15 %, republic 6 %, democracy 4 %; the rest between) × the ruler (ambitious and
  greedy rulers spend more, a frugal one less; a skilled steward wastes less) × the court's age
  (a dynasty's court grows grander over generations). And a court grows to fill a full
  treasury: above the peace reserve (see Decisions), a tenth of the excess a year goes on it.
  What it buys: the great's loyalty and the ruler's legitimacy rise with it; commoners resent it
  when taxes are high.
- **Corruption.** A share of the taxes that never reaches the treasury, drifting each year
  toward a target that grows with the realm's size against its capacity and the years since its
  last reform, falls under a skilled steward or a stern ruler, and is cut by reforms and purges
  (typically 3 % to 30 %). Large old realms become rich in land and poor in coin.
- **Ruin after revolt.** A rising, a civil war or a sacked capital leaves a timed effect: income
  down 10 % to 30 % for five to fifteen years, easing as it goes.
- **Debased coin.** A crown in arrears may clip its coin (a greedy or desperate ruler more
  readily): six months of income at once, and the coin's debasement rises by 0.15 (to 0.6 at
  most). While debased: prices rise (town happiness down), trade income down, unrest up, loans
  cost more. It recovers slowly, or quickly by a costly reform.

Today's 8 % a month on town projects stays; its reserve becomes the same peace reserve.

### Estates

Yearly, in the realm's month, from its towns' trades (`civ/jobs.js`) and its laws:

- **Sizes.** Clergy from the clergy; townsfolk from craftsmen, merchants, scholars and builders
  in towns; commoners from the rest; the unfree a share of commoners under serfdom or of
  captives under slavery; the great a small share set by the government (feudal and imperial
  realms more, republics fewer, tribes their chiefs' kin). Wealth shares likewise (the great hold
  far more than their numbers).
- **Rights** start from the government and laws, and move with reforms.
- **Loyalty** moves 15 % a year toward a target: content when its rights match its power, angry
  when they fall short; taxes weigh on commoners and townsfolk; hunger on commoners; trade and
  coin on townsfolk; faith and tolerance on the clergy; land laws and the court's favour on the
  great; bondage on the unfree. The ruler's temperament leans each (a just ruler, a cruel one).
- **What it changes.** Stability gains a part, 'estates' (the loyalty of each estate weighed by
  its power); towns gain unrest from their own estates (a farming town from its commoners and
  unfree, a city from its townsfolk), through the existing settlement modifiers.
- **Risings.** An estate with loyalty under 0.3 and power enough may rise (a yearly chance):
  - commoners: a peasant rising in the worst towns (rebels killed, fields burned, ruin), crushed
    or bought off with a tax cut or the end of serfdom;
  - the great: a noble rebellion (a pretender, a civil war, or a province breaking away);
  - townsfolk: a townsmen's revolution (a charter, a free city, or a republic or merchant
    government);
  - clergy: an interdict, or a theocracy;
  - the unfree: a revolt that frees them (the law falls) or is drowned in blood.
  Each uses the machinery that exists (`revolt`, civil war, `overthrow`, government change) and
  tells which class rose and why.

### Laws

Four laws a realm holds, and the army's way of raising shown beside them:

- **Inheritance:** eldest (one heir takes all), divided (the realm is split between heirs: see
  Decisions), elective (the great choose: their rights up, each ruler's legitimacy a little
  lower), seniority (the eldest of the house: fewer child rulers, older ones).
- **Faith:** one faith (others persecuted: the clergy pleased, minorities unhappy), tolerated
  (today's middle), free (minorities content, the clergy restless). Folds in today's tolerance
  trait.
- **Bondage:** none, serfdom (part of the commoners bound to the land: harvests up a little,
  their loyalty down, risings), slavery (captives of war held unfree: work up, revolts). Later
  eras' townsfolk and reformers push for abolition.
- **Land:** held by the crown (taxes up, the great resentful), by the great in fiefs (taxes down,
  the great loyal, feudal hosts stronger), or by freeholders (commoners loyal, harvests up).

Starting laws come from the government, era and people (`lawStart`). A law changes by reform (a
ruler's ambition, a faction's demand granted, a new government) or is forced by a rising.

### The court

Up to five factions a realm, drawn from its estates and its state: the army (soldiers, wars),
the church (clergy), old blood (the great), the guilds (townsfolk), reformers (scholars, from the
Renaissance on). Each has a sway (from its estate's power and the ruler's favour), a named
leader, and a demand drawn from its interests: a law, a war or a peace, lower taxes, a reform.
Yearly the ruler grants or refuses by temperament. Granted: the faction's estate warms, the
policy swings. Refused with high sway: court intrigue (the existing event, now naming the
faction), a coup (the army or old blood, through `overthrow`), or a purge by a cruel or
ambitious ruler (the faction broken, its leader dead, corruption cut, its estate angry).

## Events and heat

The 'faction' heat now names a faction; revolts heat 'unrest' and 'grudge' as today. New
chronicle lines: risings by estate, laws changed and why, purges and coups with their faction,
debasement, a court grown lavish, corruption scandals. Imp 2–3; a realm split by inheritance 3.

## Interface

The realm's dossier gains four sections: **Estates** (each with its share, loyalty and power),
**Laws** (each with its value and since when), **The court** (factions with sway, leader and
demand), and **Where the money goes** (income in, then the court, corruption, armies, projects,
debts, and the coin). Revolts and law changes link to them. The Ledger gains the new state and
events.

## Saves, keyframes and old worlds

Old saves gain estates, laws and a court on their first yearly pass (laws from the government;
estates sized from the trades), and a purse at once. Keyframes need nothing new: the fields are
plain JSON on the realm.

## Performance

Monthly: the purse (a few multiplications a realm). Yearly: estates, laws, court (a pass over
the realm's towns' trades, already counted). Budget: under 1 ms per simulated year.

## Gates (health checks, not targets)

- Realms at peace hold about the peace reserve (Decisions), not decades of income.
- Each estate rises somewhere in a thousand years; revolts happen a few times a century per
  world, and realms survive most of them.
- Divided inheritance splits some realms and not all; more realms is welcome, a map of
  one-town realms is not.
- No world heads for collapse; stability and wars stay in their usual range.

## Build order

A. The purse: court, corruption, ruin, coin, and where the money goes in the dossier.
B. Estates: sizes, rights, loyalty; stability and town unrest.
C. Laws: the four, starting laws, reforms; divided inheritance; bondage.
D. The court: factions, leaders, demands, coups and purges; risings by estate.
E. The interface and the Ledger; calibration (twelve worlds against main), speed, save size.

## Decisions (2026-10-27)

- **The peace reserve: three to five years of income in general, but some realms hoard or are
  particularly rich.** A realm's own reserve is four years × its thrift: its government (a
  merchant state keeps twice as much, a horde half), its ruler (a miser hoards, an ambitious
  spender keeps less) and its people (`reserveRule`; dwarven holds hoard). Most realms land at
  three to five years, a few at ten or more. Above its reserve, the court spends four tenths of
  the excess a year, and town projects take theirs as today.
- **Divided inheritance: real splits, often.** Under the divided law, a realm of six or more
  towns splits between two heirs at most successions (60 %): the heir keeps the capital and the
  towns nearest it, a younger heir founds a sister realm of the same house with the rest,
  allied at first, each with a claim on the other.
- **Bondage: serfdom and slavery,** both as laws, each with its risings, and later ages pushing
  for abolition.
- **Mythic peoples have estates of their own:** their own names for each estate, their own
  starting laws and wants, and for some no unfree at all (elves keep no thralls; dwarven holds
  do). The five roles stay the same underneath, so the mechanics are shared.
- **The court** (my default, no objection raised): named factions with leaders and demands, coups
  and purges.

## As built (2026-10-27)

Modules: `civ/power.js` (the purse, the estates), `civ/laws.js` (laws, divided inheritance),
`civ/court.js` (factions, demands, coups and purges, risings), `ui/views/power.js` (the dossier
section). Choices made while building, with the reasons:

- **Spending, sized.** The first court shares (5–18 % of income) with corruption at 10–20 %
  left realms with a year's income at Year 600 and crowns clipping their coin every few years.
  The court now takes 3–10 % by government (bent by ruler and age), corruption's middle is
  about 5–10 % (large old realms 15–25 %), and a crown clips its coin only deep in arrears and
  at most once a decade.
- **Taxes ease at the reserve.** A crown used to cut its taxes once its treasury passed a fixed
  sum; with the hoards gone that rarely happened, and taxes stayed high. It now eases them once
  it holds three quarters of its own reserve. (Kept: realms that are often short of money tax
  harder, and their towns are less content; see the calibration.)
- **Estates feel hard times.** Loyalty first moved too gently for any estate to rise; heavy
  taxes, hunger, war, a debased coin and bondage now weigh more, and anger rises faster (a
  quarter of the way a year) than it fades (an eighth).
- **The court, calmed.** Factions first pressed every year and won too often (most crowns turned
  elective). A faction now rests eight to sixteen years after it gets its way and presses again
  three years after a refusal; laws are granted at six tenths of the odds; the old blood asks for
  an elective crown only in a crisis of legitimacy; purges need a faction refused twice.
- **The bound rise in desperation** (loyalty under 0.15, not 0.3), or they would rise every few
  years everywhere bondage is the law.

### Checked in the game

A Mythic world at Year 450: the Iqaaxan Egg-Clan's dossier shows its brood-lords (5 % of the
people, 52 % of the wealth, loyal), egg-priests, traders, hatchling-kin and thralls ("near revolt,
over their bondage"); its laws (eldest heir since Year 29, one faith, slavery, the land in fiefs
since Year 397, levies); its court (the brood-lords' faction at 66 % sway led by Axssa, the army,
the traders, the egg-priests); and its money (22 a month in taxes, 10 % to corruption, 5 to the
court, a reserve of 3.5 years against a treasury of 936). No console errors.

## Results (2026-10-27)

### Gates

All pass: `npm test`, the Mythic trial, the cohort check, three 300-year Mythic trials, and the
hand check with and without myth. The keyframe check first failed (17 stale shared copies: a
fallen realm's ruler's skills changing after it closed): a claimant crowned after a war of
succession was a shallow copy sharing its skills, temperament and body with the rebel realm's
closed record, an older bug that divided inheritance's wars of succession made common. Fixed by
crowning a full copy; the check passes.

### Twelve worlds against main

Against main at 3e17cc1 (which reproduces the hand-powers runs exactly):

    Historical Y500   pop −5%   realms +56%  towns +6%  wars +50%  at war 0.179→0.216
    Mythic     Y500   pop +1%   realms +19%  towns +9%  wars +90%  at war 0.111→0.159
    Historical Y1000  pop −8%   realms +42%  towns +6%  wars +34%  at war 0.264→0.273
    Mythic     Y1000  pop −3%   realms +72%  towns +9%  wars +65%  at war 0.199→0.239
    smallest world at Y1000: 16 realms (main 7), 211 towns

- **No more hoards.** The median realm in each world holds 0.7 to 2.6 years of income at Year
  1000 (main: 4 to 58, one world's median 58). Realms long at peace hold two to five; the middle
  of all realms sits lower because more of them are at war or paying for one. Open loans
  between crowns rose from 48 to 181: crowns without hoards borrow.
- **More realms and wars.** Divided inheritance splits a realm every 40 to 75 years per world,
  the sister realms hold claims on each other, and the army's faction presses for war on hated
  neighbours; risings and coups add more breaks. Population and the ages reached are about
  main's.
- **Stability** lands near main in some worlds and below in others (Year 600, three test worlds:
  0.62 against 0.72, 0.67 against 0.60, 0.56 against 0.55): realms that no longer hoard tax
  harder in hard times, and their towns are less content.

### Speed

Year-900 main saves, 100 years, three rounds: +11.6 % (historical) and +13.8 % (Mythic) per
simulated year. The chunk's own code (purse, estates, laws, court) costs about 1.5 ms a year,
under 1 % of the 190 ms a simulated year takes (budget: 1 ms); the rest is the larger world it
makes: more realms and wars to simulate (war +30 %, diplomacy +37 %, the realm system +15 %).

### Save

A Year-900 save from main, 100 years on: 22.68 MB on main, 22.84 MB on the branch (+0.7 %, about
900 bytes a realm). The old save loads and runs: every realm gains its estates, laws and court
on its first yearly pass.
