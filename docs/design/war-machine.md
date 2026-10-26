# The war machine — design

Chunk 2 of the deeper-simulation plan (the Deep Dive, "the work in chunks"): **army companies**,
**arms and armour**, **how the army is raised**, **veterans and regiments** and **battles in
full**.

Today an army is one number, its strength. A battle compares strength, morale, supply, the
general and the realm's military bonus, plus 15 % per era of difference. A levy is raised only in
wartime, for a one-off quarter crown a soldier, and nothing is paid after that. Only hired
companies cost money every month (0.6 a soldier). So war barely touches a treasury, and realms
sit on years of income (chunk 3's results).

After this change:
- **Companies.** An army is made of companies by role: spears, blades, bows, light horse, heavy
  horse, engineers and, in Mythic worlds, war beasts. Each has its gear and its experience.
- **Battles.** A battle is decided by what is fighting: pikes against knights, horse archers
  against foot, the ground and the weather, the general's plan. It is told in full: who broke,
  who pursued, how many were taken.
- **Raising.** Each realm raises its armies its own way: a tribal levy, a feudal host, a paid
  standing army, or hired swords. Soldiers are paid every month. A long war empties a treasury,
  and an unpaid army deserts, mutinies or, if it stands at home, overthrows its ruler.
- **Regiments.** A standing army's companies are named regiments that outlive their wars, with
  honours, last stands and histories. Levies come home as veterans.

## Goals and non-goals

- **Goals.**
  - Armies by role and gear, so battles depend on what fights and technology gaps win wars.
  - Four ways of raising armies, chosen per realm and changed by reform.
  - Pay every month, so war drains treasuries and chunk 3's loans and defaults follow.
  - Regiments with names and histories; veterans who make the next levy better.
  - Battle accounts worth reading, kept in the war's record.
- **Non-goals.**
  - Sieges and walls in detail (chunk 6). Engineers only speed today's siege here.
  - Navies by ship type. Fleets fight as today.
  - Individual soldiers. Companies are counts.
  - Goods and arsenals as stocks. Gear quality reads the realm's mines and production.

## Rule: societies vary

| Rule | Default here | Later variations (examples) |
| --- | --- | --- |
| **How the army is raised** (`armySystem`, first) | By era, government, wealth and temper (below) | Laws that ban a standing army; a warrior caste; a faith's militant orders |
| **What it fights with** (`armyMix`, first) | Shares by role from era, technologies, land and temper (below) | Each Mythic people's style (decision 4); a horse people of the steppe; a law that keeps horses for nobles |
| **What a soldier costs** (`armyPay`, first) | The table under "Pay" | A tithe that feeds the army; plunder that pays it; a merchant republic paying in silver |
| **Who serves** (chunk 1's `cohortRule` levy) | Men 15 to 44 | Unchanged here; the system decides how many and how often |

## Gates

As in chunks 1 and 3: `npm test`; `--trial --set mythLevel=2`; the three 300-year Mythic trials;
the keyframe check; the cohort check; byte-identical with and without the myth module at
mythLevel 0. New draws are allowed, each on `world.rng` at a fixed point. Calibration across the
twelve worlds against main: population, realms, towns, wars, time at war, war length, plus
treasuries (median years of income held), loans and defaults, battles, the share of battles won
by the larger army. Speed: at most +2 % per sim-year (battles grow, but they are rare). Save: at
most +150 KB at Year 1000.

## Data

### Companies: `army.co`

An array of companies, at most 8 an army: `[role, n, gear, q, xp, reg]`.
- `role`: 0 spears, 1 blades, 2 bows (later crossbows, then shot), 3 light horse, 4 heavy horse,
  5 engineers (later guns), 6 war beasts.
- `n`: men in it. The army's `strength` stays the sum, so every existing reader keeps working.
  Any loss the kernel applies (`damageArmy`) is spread over the companies at the next read.
- `gear`: tier 0 to 6 (below). `q`: quality and condition, 0.4 to 1.2. `xp`: experience 0 to 1.
- `reg`: the regiment's id when the company is a standing regiment, else absent.

### The realm's war footing: `civ.forces` (built name)

`{ sys, since, cand, candN, arrears, regs, vets, deserted, learned, coupDay }`:
- `sys`: `levy`, `feudal`, `standing` or `hired`; `cand`/`candN` the way it leans toward and for how
  many years (a reform needs three).
- `arrears`: months running its treasury has stood below zero after its expenses.
- `regs`: its regiments `[{ id, name, role, n, gear, q, xp, founded, battles, won, honours, out, levy, levyDay }]`,
  at most 12. A regiment keeps its men out of the towns while it serves (`levy` is their shape).
- `vets`: veterans at home, a count that fades as they age (5 % a year).
- `learned`: battle plans taken up from those who beat it.

A new civ field, declared in `CIV_SHAPE` after `landClaims`, set at the realm's first month.
The month's bill is not stored: the civ module asks the ext `upkeep` (sum) each month.

### Battles in full

Each battle in the war's ledger (`geo/ledger.js noteBattle`) gains `{ g, wx, t, k, by, p }`:
- `g` the ground (fords, hills, pass, marsh, wood, sands, snows, shore, field).
- `wx` the weather (clear, rain, snow, heat, fog).
- `t` each side's plan, `k` the moment that decided it.
- `by` the losses by role, each side. `p` prisoners taken.

## Mechanics

### Roles and their match-ups

Each role has a base worth and a match-up against each other role, read as the share of the
enemy it faces (a row × the enemy's mix):

| | vs spears | vs blades | vs bows | vs light horse | vs heavy horse | vs beasts |
| --- | --- | --- | --- | --- | --- | --- |
| Spears | 1.0 | 0.85 | 0.8 | 1.2 | 1.45 | 1.2 |
| Blades | 1.2 | 1.0 | 1.15 | 0.9 | 0.8 | 0.9 |
| Bows | 1.2 | 1.1 | 1.0 | 0.75 | 0.85 | 1.1 |
| Light horse | 0.75 | 1.0 | 1.35 | 1.0 | 0.8 | 0.8 |
| Heavy horse | 0.65 | 1.3 | 1.35 | 1.15 | 1.0 | 0.9 |
| Beasts | 1.0 | 1.2 | 1.0 | 1.2 | 1.15 | 1.0 |

Base worth per man: spears 1.0, blades 1.1, bows 0.9, light horse 1.4, heavy horse 2.2, beasts 3.
Engineers fight at 0.4 and add to siege power (× 1 + 4 × their share, capped at × 1.6).

Ground: horse × 0.6 in forest, marsh and hills, × 1.15 on open plain and steppe; bows × 1.2 on
hills; spears × 1.15 holding a ford or a pass. Weather: rain and snow take a quarter from bows
and a fifth from horse; heat takes a tenth from heavy foot and heavy horse.

### Arms and armour

Gear tier from the realm's knowledge:

| Tier | Gear | Comes with |
| --- | --- | --- |
| 0 | stone and hide | — |
| 1 | bronze | Bronze Working |
| 2 | iron | Iron Working |
| 3 | steel and mail | Feudalism or Engineering, with iron |
| 4 | early guns, plate | Gunpowder |
| 5 | rifles | Industrial Chemistry or Railways |
| 6 | modern arms | Combustion Engine |

Bows become crossbows at tier 3 and shot at tier 4; engineers bring guns at tier 4. In battle each
tier above the enemy's average gear is worth × 1.18. Today's era gap (× 1.15 per era) is
replaced by this, so the world's balance between eras stays about where it is.

Quality `q`:
- It starts from the realm's mines and production. Iron, copper and tin within its lands lift it;
  their lack lowers it.
- It wears in the field (−1 % a month).
- It is restored at home at a cost from the treasury.
- A company can take the gear of a routed enemy, raising its quality to theirs when theirs is
  better.

### How the army is raised

Pay below is in units of `w`, the month's pay of one levied soldier, which is a share of the
realm's income per head (decision 1).

| System | Who | Raised | Pay a soldier a month | Drill | Kept at peace |
| --- | --- | --- | --- | --- | --- |
| **Levy** | the young men of the towns (chunk 1) | 40–100 days | `w` in the field | none | no |
| **Feudal host** | lords' retinues (heavy horse, blades) and their levies | 20–50 days | `w` for the levies; the lords' share is owed service, not coin | lords' retinues 0.3 | the retinues, at no pay |
| **Standing army** | paid regiments, filled from the young men | at once | 2 `w`, at peace too | 0.5, rising | yes: about a fifth of manpower |
| **Hired** | the realm's own levy, plus free companies bought at war (bands/hire.js) | as levy | `w`, and the companies' own fee | none | no |

How each realm chooses (yearly; a change is a reform, written in the Chronicle):
- Tribes and eras 0 to 1 raise a levy.
- Feudal monarchies from Feudalism raise a feudal host.
- From Military Tactics (Classical legions) or Gunpowder (the new armies), a realm whose income can
  carry it, at war at least a fifth of the last half-century, keeps a standing army.
- Merchant republics, and realms rich in trade but short of men, hire.
- The ext `armySystem` may answer for any realm.

What the system does:
- **A feudal host** musters fast, but the lords' service runs out: after a season, weariness
  rises a third faster.
- **A standing army** is ready at once and drilled. It costs every month, at peace too, and
  stands at home as regiments.
- **Levies** go home when the war ends (as today), as veterans. A realm's veterans raise the
  experience of its next levy (`vets` over the levy's size, up to 0.4).

### Pay

Each month the realm pays its armies in the field, its standing regiments, and a tenth of a crown
for each hundred soldiers of garrison. It is counted in its expenses, before its surplus goes to
building.

A realm that cannot pay in full falls into arrears:
- **The army's morale** falls (−0.05 a month in arrears).
- **Desertion.** A levy melts away (1 % a month for each month owed).
- **Hired companies** turn as today.
- **A standing army** may overthrow its ruler after three months unpaid, or when stability falls
  below 0.25 (decision 3). The coup is rare: 0.6 % a month while unpaid, 0.3 % in a crisis, times
  the ruler's coup factor, and never twice in twenty years.

Chunk 3's borrowing reads the expenses, so a realm at war with its pay outrunning its income
borrows, and one that cannot borrow sues for peace sooner.

### Veterans and regiments

- **Experience.** Each battle adds experience to the companies that fought (+0.08 for the winners,
  +0.04 for the losers who survive). Drill adds to a standing regiment at home, up to its system's
  ceiling. Experience is worth up to × 1.35 in battle and steadies morale.
- **Regiments.** A standing army's companies are named ("the Iron Spears of Oskel", "the Third
  Legion", "the Queen's Lancers"), from the realm's language, its capital, its ruler and its era.
  A regiment keeps its battles, victories and honours.
  - **Honours.** A regiment in a named victory where its role decided the day earns an honour,
    shown in its name ("the Iron Spears of Oskel, of Varn Ford").
  - **Last stands.** A regiment destroyed covering a retreat is remembered in the Chronicle.
  - **Disbanded.** A regiment the realm can no longer pay, or one it disbands when it gives up its
    standing army, is disbanded.

### Battles in full

When two armies meet:

1. **The ground and the weather.** The ground is today's site kinds; the weather comes from the
   tile's rain, snow and temperature that day.
2. **Each side's plan.** Chosen from its mix, its general's skill and the ground. One of: hold the
   line, shield wall, pike square, archers' storm, flanking charge, feigned retreat (light horse),
   the hammer and anvil (heavy horse with foot), volley fire (shot), a night attack (a skilled
   general against a larger host). A plan suits some mixes and grounds and lifts that side by
   5–20 %.
3. **The clash.** Each side's power is the sum over its companies: men × base worth × gear × the
   match-up against the enemy's mix × the ground and weather × experience × quality. Then
   × morale, supply, the general's skill, the realm's military bonus (doctrine, now without the
   era gap), the ext `battle` providers, and luck (0.75 to 1.3, today 0.7 to 1.35).
4. **Losses by role.** The loser loses most where the enemy was strong against it (horse
   cut down by pikes, foot by knights).
5. **The pursuit.** The winner's light horse multiplies a routed enemy's losses (up to × 1.5).
   Prisoners are a share of the routed (5–15 %); the winner may ransom them at the peace, or
   free them when the war ends.
6. **The decisive moment.** What decided the day, written into the account and the prose:
   "the Varn knights broke on the Oskel pikes at the ford".

**Famous tactics copied.** A realm beaten in a named battle by a plan it does not know learns it
(×1.5 the chance to choose it), so the feigned retreat of the steppe spreads to its victims.

## Events and heat

- `army.reform`: a realm adopts a standing army, a feudal host or hired swords (2, or 3 for a
  great realm).
- `army.coup`: the army overthrows its ruler (3).
- `army.desert`: an unpaid levy melts away (2).
- `regiment.raised` (1, the first regiment of a realm only), `regiment.honour` (1),
  `regiment.laststand` (2), `regiment.disbanded` (1).
- `battle.*`: today's keys, with richer text.
- `war.prisoners`: prisoners ransomed at a peace (folded into the treaty line).

Rate limits as in chunks 1 and 3.

## Interface

- **Army dossier.** Its companies in a table: role, men, gear, experience, regiment. The realm's
  way of raising armies, and its pay.
- **Realm dossier.** Under Armed forces: the system and since when, the month's pay, arrears, its
  regiments (linked to their histories), and its veterans.
- **War dossier.** Each battle row gains its ground, weather and plans; a battle opens its account.
- **Battlefield sites.** A battlefield shows the account of the battles fought there.
- **Statistics.** Treasuries' median years of income held, alongside the debts of crowns.

## Saves, keyframes and old worlds

- **Old armies.** An army without companies gets them at its first read, from its realm's mix
  and gear, at average experience.
- **Old realms.** A realm without `war` gets it at its first monthly pass, choosing its system
  quietly with no reform line.
- **Format.** The new civ field takes its place through the in-order reshape from chunk 3.
- **Keyframes.** Armies and civs are already captured.

## Performance

Companies are at most 8 an army, and armies number in the dozens; regiments are at most 12 a
realm. Battles are rare. Pay is one pass over the armies and regiments a month. Expected: well
under 1 % of a sim-year. Measured at the end.

## Build order

One go on `sim/war-machine`, a commit per phase, stopping only for decisions that are the
user's:

1. **Companies and gear.** Roles, the mix rule, gear tiers and quality, battles by match-ups,
   losses by role, mixes for hired companies and hordes, the army dossier.
2. **How the army is raised, and pay.** The four systems, reforms, monthly pay and arrears,
   desertion, standing regiments kept at peace, coups, the realm dossier.
3. **Veterans and regiments.** Experience and drill, named regiments with honours and last stands,
   veterans for the next levy.
4. **Battles in full.** Ground, weather, plans, the pursuit, prisoners and ransom, battle accounts
   in the ledger and the prose, tactics copied, the war dossier and battlefields.
5. **Calibration, speed, gates and results**, then the Ledger and the Deep Dive.

## Decisions

The user's choices, recorded when made:

1. **How hard war drains the treasury: by the realm's means.** An average or poorer treasury
   carries a full war for 3 to 5 years; a richer one lasts longer. So pay is not a flat coin: a
   soldier costs a fixed share of what the realm takes in per subject (its income per head), and
   that share is tuned on the calibration worlds so the median realm at war, fully mobilised,
   empties its treasury in about four years. Rich treasuries outlast that by what they hold.
2. **The ways of raising armies: all four.** Levy, feudal host, standing army and hired swords.
3. **Coups by a standing army: yes, rarely.** About 2 % a month while it is three months unpaid
   or its realm is in crisis, times the ruler's coup factor.
4. **Mythic peoples' ways of war: now.** Each people has its own mix (elves bows, dwarves
   armoured blades and spears, orcs wolf-riders and war beasts, halflings slings and spears,
   lizardfolk spears and swamp beasts); its beast-keepers (chunk 1's magical trades) supply its
   war beasts. The myth module answers `armyMix`; at mythLevel 0 it answers null.

Defaults taken without a question (say if any should change):
- Fleets fight as today; navies by ship type are not in this chunk.
- Prisoners are ransomed at the peace or freed when the war ends.
- Tactics copied by those they beat are part of the chunk.
- Engineers only speed today's siege; walls and siegecraft are chunk 6.
