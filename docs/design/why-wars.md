# Why wars start and how they end — design

Chunk 3 of the deeper-simulation plan (the Deep Dive, "the work in chunks"): **claims on land**,
**war aims and peace terms**, **town memory** and **debt between crowns**. Today a war has one
casus belli and, sometimes, one goal town. It ends by war score, and the terms are fixed by the
score alone: the towns each side holds, tribute above 45, vassalage above 65. A realm remembers a
lost war only as `grievance`, which halves in about five years. A town forgets everything. A
treasury can run dry, but no one ever lends.

After this change:
- **Claims:** a realm remembers every town it lost, for generations.
- **Aims and terms:** every war has aims on both sides, and its peace is written from those aims.
- **Memory:** a town remembers who sacked it and who saved it.
- **Debt:** crowns borrow, pay interest, default, and go to war over it.

Wars get reasons, and a harsh peace sows the next war.

## Goals and non-goals

- **Goals.**
  - Wars fought for named towns and crowns, with each side's aim shown in the war's dossier.
  - Treaties whose terms follow the aims: border changes, reparations, hostages, a crown, a
    faith, claims renounced.
  - Revenge across generations: lost towns become claims that fade slowly, and a harsh peace
    keeps them alive.
  - Towns that open their gates to a remembered friend, or hold out against a hated foe.
  - Loans between crowns and banking houses, with interest, defaults and wars over debt.
- **Non-goals.**
  - Changing how often the world is at war. The war-share governor (`WAR_SHARE`, `worldF`,
    `ownF` in `war.js`) stays as it is. This chunk changes who fights whom, why, and how it ends.
  - Goods, prices and merchant houses as full entities (left out of the plan). Banking houses
    here are light records: a name, a seat and money.
  - Feelings between peoples (chunk 8). How long each people remembers is in this chunk for
    Mythic worlds (decision 4); chunk 8 builds the feelings on top of it.
  - Laws (chunk 7). A law against usury, or one that forbids hostages, is a rule a later chunk
    can set.

## Rule: societies vary

Every "who" and "how long" is a rule with a default, read through an extension point. The
defaults are listed here; later chunks vary them without touching the mechanics.

| Rule | Default here | Later variations (examples) |
| --- | --- | --- |
| **How long a realm claims a lost town** | Fades with an e-folding time of 60 years; 120 years for a town it founded. In Mythic worlds each people has its own (below) | A crown that has its claims renewed by its chroniclers; a faith that keeps them |
| **Who inherits a fallen realm's claims** | The realm with the strongest crown claim on it, else its daughter realm, else its parent | Peoples who pass claims to their kin; a faith that claims for its holy realm |
| **What a war is fought for** (aim by casus belli) | The table under "War aims" | Nomads who want plunder, not land; a faith that wants souls, not towns |
| **What a victor may demand** | All the terms under "Peace terms" | A faith or a law that forbids hostages or forced conversion |
| **How long a town remembers** | Grudges fade over 40 years, gratitude over 25. In Mythic worlds each people has its own (below) | Feelings between peoples (chunk 8) |
| **Who may lend, and at what interest** | Realms from era 1 (Bronze Age); banking houses from era 4 (Medieval Age); 8 % a year plus risk | A faith or law against usury; a merchant republic that lends cheap |

Each rule is one function call:
- `claimRule`: **first**, `(w, civ)` → `{ tau, foundedTau }` in years, or null.
- `warAim`: **first**, `(w, a, b, cb)` → an aim, or null.
- `peaceTerms`: **first**, `(w, winner, loser, term)` → false to forbid a term, or null.
- `memoryRule`: **first**, `(w, s)` → `{ grudge, thanks }` in years, or null.
- `lendingRule`: **first**, `(w, lender, borrower)` → `{ allowed, rateMul }`, or null.

## Gates

This chunk changes history on purpose, so it is not bit-identical with main. It must hold:

- **Determinism.** `npm test` passes, including `--determinism`, `--rewind-test` and
  `--trial`. `--trial --set mythLevel=2` passes. Long Mythic trials of 300 years on seeds
  `deep`, `trial` and `amber` pass. The keyframe check passes.
- **Myth module.** At mythLevel 0 a world with and without the myth module stays
  byte-identical. Everything here lives in `src/sim/geo` and `src/sim/civ`.
- **Randomness.** New draws are allowed (this chunk adds choices), but every draw is on
  `world.rng` at a fixed point in the monthly or daily order. None comes from a cache.
- **Calibration.** This is a health check, not a target. Across twelve worlds run to Years
  500 and 1000, report world population, living realms, towns, wars, and the share of time at
  war. The user's rule applies: totals may move if worlds stay interesting and mostly
  successful. New measures:
  - share of wars by aim
  - share of wars ended by an aim met
  - average war length
  - claims per realm
  - wars of reconquest per century
  - loans and defaults per century
  - gates opened per century
- **Speed.** At most +1 % per sim-year in `tools/timeab.mjs` on the Year-900 saves, both
  Historical and Mythic. Everything here runs on events or small monthly lists.
- **Size.** A save grows by at most 100 KB at Year 1000 on a medium map.

## Data

### Claims: `civ.landClaims`

`{ [sid]: [w, why, since, tau] }`. The fields:
- `w` is the strength when the claim was last renewed, from 0 to 1.
- `why` is one of:
  - `f`: the realm founded the town.
  - `l`: lost in war or at a treaty.
  - `s`: lost to a rising (secession or defection).
  - `i`: inherited from a fallen realm.
- `since` is the day it was last renewed.
- `tau` is the fading time in years.

The live strength is `w · exp(−years/tau)`. A realm keeps at most 12 claims, the strongest.
A claim below 0.08 is dropped.

A new field on the civ record, at the end of `CIV_SHAPE` (`world.js`). An old save without it
is seeded at load from every town's owner chain `s.own` (below). So an old world loads with its
claims already in place.

Holy ground is **not stored**. A faith's holy city held by unbelievers is read live, as it is
today.

### War aims: `war.geo.aims`

`{ a: aim, d: aim }`. An aim is `{ k, sids?, rid?, civ? }`:
- `k` is the kind: `towns`, `crown`, `faith`, `tribute`, `subjugate`, `free`, `debt`,
  `humble` or `hold`.
- `sids` is up to 3 goal towns.
- `rid` is a faith.
- `civ` is the crown sought.

`war.geo.goalSid` stays as the first goal town, so old code and old saves keep working.
`war.geo.terms` gains these fields:
- `reparations` (a sum)
- `hostage` (a name)
- `renounced` (the towns given up)
- `faith` (true or false)
- `crown` (`union` or `puppet`)
- `harsh` (0 to 1)

### Town memory: `s.mem`

Up to 4 entries `[civId, v, why, day]`. The fields:
- `v` runs from −1 to +1.
- `why` is one of:
  - `k`: sacked
  - `z`: a neighbour razed
  - `h`: held out against a siege
  - `r`: relieved
  - `f`: freed by its old realm
  - `c`: ceded away by its own crown
  - `g`: opened its gates
- `day` is when the memory was last renewed.

The live value is `v · exp(−years/tau)`, with tau from `memoryRule`: 40 years for grudges
(v < 0), 25 for gratitude. A new memory of the same realm merges with the old one. The four
strongest are kept.

A new settlement field, added to `createSettlement` and `SETTLEMENT_SHAPE` after `jobs`, so
the Mythic-only `peoples` fields stay last. Old saves start with no memories.

### Loans: `world.sys.geo.loans` (diplomacy state)

`{ id, from, to, owed, pay, rate, start, until, arrears, kind }`. The fields:
- `from` is a realm id, or `-1 − houseId` for a banking house.
- `owed` is what is still owed.
- `pay` is the monthly payment.
- `rate` is the yearly interest.
- `kind` is `loan` or `reparations`.

A debtor has at most 3 loans. Defaults are kept per realm in `civ.flags.dflt`, the day of its
last default.

### Banking houses: `world.sys.geo.houses`

`{ id, name, seat, capital, founded, failed }`. At most one per realm and eight in the world.
Each is named after a family in its seat's language ("the House of Vell of Oskel").

## Mechanics

### Claims on land

**Made.** When a town leaves a realm through conquest, a treaty, secession or defection, the
realm that lost it gains a claim. The claim's strength:
- 1.0 if the realm founded the town (tau 120 years).
- Otherwise 0.3, rising to 0.85 for a town held 50 years or more (tau 60 years).
- ×1.25, capped at 1, for a former capital.

If the realm already claimed the town, the claim is renewed to the stronger value.

**Dropped.** A claim is dropped when:
- the town is razed or abandoned
- the claimant takes it back
- the claimant renounces it at a treaty (see Peace terms)
- the claim fades below 0.08

The yearly pass drops faded claims in the realm's own month.

**Inherited.** When a realm falls, its claims pass at ×0.7 to its heir. The heir is the realm
with the strongest crown claim on it (`civ.claims`, at least 0.4). Failing that, a living
daughter realm (`parentId`). Failing that, its parent. Claims on the heir's own towns are
dropped. This is how a fallen kingdom's lost provinces stay contested for centuries.

**Effects.**
- *Casus belli.* `reconquest` takes the strongest claim the attacker holds on any of the
  target's towns: `w = 0.9 + 1.1 × strength`. That is 2.0 for a fresh claim on a founded town,
  against today's flat 1.7. The goal is that town. The aim also takes up to two more claimed
  towns the target holds.
- *Opinion.* A realm that holds towns another realm claims is seen worse by that realm:
  −10 per unit of claim strength, capped at −25 (in `targetOpinion`, `diplomacy.js`). Lost
  provinces are mourned, and old neighbours stay cool.
- *Chronicle.*
  - When a realm loses a capital or a town of tier 3 or more: "In Oskel they swore that Varn
    would be theirs again." Imp 2, at most once a decade per realm.
  - When a claim on a great town fades after more than a century: "By Year 812 no one in
    Oskel remembered that Varn had once been theirs." Imp 1.

### War aims

At declaration, each side gets an aim. The attacker's aim comes from its casus belli:

| Casus belli | Attacker's aim |
| --- | --- |
| reconquest, border, resource, prophecy, relic, witchstone | `towns`: the goal town plus up to two more the attacker claims, or the nearest border towns |
| holy | `faith` (the target's crown takes the attacker's faith), plus the holy city as a town when the target holds it |
| succession, claim, restoration | `crown`: the target's throne for the attacker's house (restoration: for the exiled house) |
| trade, opportunism | `tribute` |
| revenge, enmity, provocation | `humble`: reparations and a hostage |
| conquest | `subjugate` when the attacker is at least 2.5 times as strong, otherwise `towns` (the richest border towns) |
| liberation | `free` |
| debt (new, below) | `debt`: reparations of what is owed, with a town as pledge |
| civil war, independence | unchanged (the civ module settles them) |

Casus belli from other packages (the `casusBelli` point) may carry their own `aim`. Otherwise
they take `towns` if they name a goal town, and `tribute` if they don't.

The defender's aim is `hold`. If the defender has claims on the attacker's towns, it is
`towns` on up to three of them, and those are demanded only if the defender wins.

The aim drives two things:
- **Ending.** Today's "goal taken" end becomes "aim met":
  - `towns`: the attacker holds all its goal towns.
  - `tribute`, `humble`, `debt`: the war score has stayed at 40 or above for a year.
  - `subjugate`: a score of 60 or more.
  - `crown` and `faith`: a score of 55 or more with the target's seat besieged or taken.

  Every other ending (capitulation, decisive, exhaustion, stalemate, endless) is unchanged.
- **Terms**, below.

### Peace terms

The winner's leader demands from its aim first, then adds extras as the score allows. `terms`
is today's `|score|`, at least 55 after a capitulation. The towns each winner holds are ceded,
as today. White peace returns everything, as today.

| Term | When |
| --- | --- |
| **Border changes** | Goal towns the winner does not hold are ceded at the table, one per 20 points above 30. This replaces today's "one town at 85". |
| **Tribute** | `tribute` aim at 25 or more; any aim at 45 or more (as today) |
| **Reparations** | `humble` or `debt` aim at 30 or more; any other aim at 60 or more. A sum of (terms − 30) / 40 years of the loser's income, capped at 1.5 years, paid over 8 to 15 years. A `debt` aim adds what is owed. |
| **Hostage** | `humble` aim, or 50 or more, when the loser's ruler has an heir. The heir lives at the victor's court until the truce ends. |
| **Vassalage** | `subjugate` aim at 45 or more; any aim at 65 or more (as today). The loser must be weak. |
| **Crown** | `crown` aim at 55 or more (decision 2) |
| **Faith** | `faith` aim at 50 or more (decision 3) |
| **Claims renounced** | When the winner was the attacker and the peace is not harsh: the loser gives up its claims on every town the winner now holds. |
| **Independence** | `free` aim (as today) |

**Harshness.** The terms add up to `harsh`, from 0 to 1. Each town ceded beyond the aim counts
0.2, reparations 0.2, a hostage 0.1, vassalage 0.3, a crown 0.4, a forced faith 0.3. Above 0.5
the peace is harsh. The effects of a harsh peace:
- The loser renounces nothing.
- Its claims on the ceded towns fade at half speed for 60 years (tau doubled).
- Its grievance rises by `20 × harsh` on top of today's.

The treaty line in the Chronicle says when a peace was harsh: "a peace that shamed Oskel".
A harsh peace sows the next war through the very claims it leaves.

**Hostages.** A hostage is a record `{ civ, at, name, until }` in the diplomacy state, kept
while the truce lasts. Its effects:
- While the hostage is held, the loser's appetite for war on the victor is ×0.1.
- If the loser attacks anyway, the hostage is put to death: grievance +40, and a Chronicle
  line.
- If the loser's ruler dies, the hostage is sent home to be crowned. The heir record itself
  stays with the dynasty code.
- When the truce ends, the hostage returns: opinion +10 both ways. A long stay at a foreign
  court leaves the heir fond of it: when crowned, the heir's opinion of that court is +15.

**Reparations** are a loan of kind `reparations` from the victor at no interest, paid monthly.
A loser that cannot pay falls into arrears and may default, exactly like a loan (below). A
default on reparations gives the victor a `debt` casus belli.

### Town memory

**What a town remembers.**

| Event | Toward | v |
| --- | --- | --- |
| Sacked (taken and not razed) | the taker | −0.5 |
| A town within 8 tiles razed (same realm or same founder) | the razer | −0.4 |
| Held out against a siege of 6 months or more | the besieger | −0.2 |
| Siege lifted by a victory nearby | the relieving realm | +0.4 |
| Freed: taken or handed back to its founder or a claimant | the new holder | +0.4 × (1 − assimilation) |
| Ceded away at a treaty | its own former crown | −0.3 |
| Opened its gates (below) | the realm it opened to | +0.1 |

Assimilation is the town's existing `flags.assim`. A town long assimilated into its holder
feels being "freed" mostly as another conquest.

**What memory does.**
- *Loyalty.* The town's loyalty target moves by `0.25 × memory of its own crown`. A town ceded
  away and then won back trusts its crown less. One saved by its crown is steadier.
- *Sieges.*
  - A town that hates its besieger holds out: siege progress × `(1 + 0.5 × memory)`, floored
    at 0.6.
  - A town that remembers the besieger kindly (≥ +0.3) and is cold to its own crown (memory
    ≤ −0.2, or loyalty below 0.3) may **open its gates**. The chance is 3 % a month × the
    gratitude. The town is taken without a sack. The Chronicle names the memory: "Remembering
    how Varn had saved it in the Salt War, Oskel opened its gates."
  - A notable hold-out (a year or more) by a town with a grudge gets one line, at most once a
    decade per realm.
- *Revolts.* `revolt()` today defects to the realm that founded the town. It now prefers the
  realm the town remembers best (≥ +0.3, near or bordering), and falls back to the founder.
- *After a capture.* A town that hated its conqueror starts with more unrest:
  `0.25 + 0.3 × grudge` instead of 0.25.

### Debt between crowns

**Borrowing.** Monthly, in the diplomacy pass, a realm may seek a loan when all of these hold:
- era 1 or later
- at war, or its treasury below three months of expenses
- fewer than 3 loans
- no default in the last 30 years

The chance is 15 % a month.

It borrows 12 to 24 months of its income. The lender is the best offer among:
- **Realms** in contact, at peace with the borrower, with opinion of it at least +10 and a
  treasury of at least twice the loan.
- **Banking houses** (decision 1), whose seat's realm is at peace with the borrower.

The lender is the one offering the lowest interest: `8 % + 10 % × (1 − stability) + 6 % ×
defaults in the last century`, −2 % between allies, × `lendingRule`. A house lends more
readily and charges +2 %. The loan runs 10 to 20 years, repaid monthly in equal parts with
interest.

**Paying.** Each month the payment comes out of the treasury, counted with expenses. A realm
that cannot pay falls into arrears, and the interest adds to what it owes. After 12 months in
arrears, the chance of a default each month is 4 % × (1 + months in arrears / 12). It rises
for a cruel or mad ruler, a stability below 0.3, or a debt above five years' income. A debt
paid off is closed.

**Default.**
- *The debtor.* Legitimacy −0.1, stability −0.05, no credit for 30 years, and `flags.dflt`
  set. A crown already weak can be pushed by this into the existing crisis, coup and collapse
  machinery. That is how bankers topple kings.
- *A lending realm.* It loses what is owed. Its opinion of the debtor drops by 40 and its
  grievance rises by 30. It gains a `debt` casus belli on the debtor for 30 years: `w = 1.0 +
  owed / its yearly income`, capped at 2.
- *A lending house.* If the loss exceeds half its capital, the house fails. Its seat loses
  half its wealth, the house is marked `failed`, and the Chronicle says so: "The House of Vell
  of Oskel failed, ruined by the debts of Tessaly."

**Banking houses.** Once a year, a realm of era 4 (Medieval Age) or later whose richest trade town has
tier 3 or more and a trade income in the top tenth of the world may found a house there. The
chance is 5 % a year. There is at most one per realm and eight in the world.
- A house starts with capital equal to a year of the seat's trade income. It earns 1/12 of that
  income each month, plus the interest it is paid.
- If its seat is razed or changes hands, the house moves to its realm's next-richest town. If
  the realm has none, the house closes.

**What debt does to war.** Money raises armies: `mobilize` already shrinks an unpaid levy to
as little as half strength. So a realm with credit fights at full strength for longer, and one
cut off from credit sues for peace sooner.

## Events and heat

New Chronicle keys, each rate-limited like the people news (`peoplenews.js`):
- `claim.sworn` (2), `claim.faded` (1)
- `war.terms.harsh` (folded into the treaty line, no extra entry)
- `hostage.taken` (folded into the treaty line), `hostage.killed` (3), `hostage.home` (1)
- `town.gates` (2, or 3 for a capital or a town of tier 4 or more), `town.held` (2)
- `debt.loan` (1, only loans of a year's income or more), `debt.default` (2, or 3 for a
  realm among the five greatest), `bank.founded` (1), `bank.failed` (2)

Declaration lines gain the aim where today's text has none: "… to win back Varn and Oskel",
"… to set its prince on the throne of Tessaly". Treaty lines list the terms that were not
there before: reparations, the hostage's name, claims renounced, the crown, the faith.

## Interface

- **War dossier.**
  - Each side's aim, in words: "To win back Varn, Oskel and Tirn", "The crown of Tessaly",
    "To hold its own".
  - The terms table gains rows for reparations (paid so far), hostage, faith, crown and claims
    renounced, plus "A harsh peace" when it was.
  - The opening line names the aim instead of the cause alone.
- **Realm dossier.**
  - **Claims**: each town claimed, why, and how strong in words ("a living claim", "a fading
    claim"), linked.
  - **Debts**: owed to whom and owed by whom, with arrears. A realm's houses are listed with
    their capital.
- **Town dossier.** "Claimed by" (realms, linked), and "Remembers" (up to four lines: "Sacked
  by Oskel in Year 612, a bitter memory"; "Saved by Varn in Year 640").
- **Statistics.** One new series on the realm and world pages: debt owed, as a share of income.

## Saves, keyframes and old worlds

- **New fields.** Claims are seeded from owner chains on load. Memories, aims and loans start
  empty in old saves. Old wars with no `aims` read as `towns` (with `goalSid`) or `hold`.
- **Format.** `SETTLE_FIELDS_V` and the civ shape version move up by one, with the same
  prefix rule as in chunk 1.
- **Keyframes.** Loans and houses live in `world.sys.geo` and are captured with it. Claims ride
  on the civ record and memories on the settlement record, which keyframes already share.
- **Save size.** Measured on the Year-1000 saves.

## Performance

| Work | When | Size |
| --- | --- | --- |
| Claims made, renewed, dropped | on transfers and destructions | ≤ 12 per realm |
| Claims fading | yearly, per realm | ≤ 12 |
| Casus belli from claims | only for a realm whose appetite passed, per neighbour | that neighbour's towns, as today |
| Opinion from claims | monthly, in `targetOpinion`, per pair | ≤ 12 per realm |
| Aims | at declaration | one per war |
| Terms | at peace | one per war |
| Memory written | on sacks, razings, sieges, cessions | ≤ 4 per town |
| Memory read | monthly, in the loyalty update and the siege tick | ≤ 4 per town |
| Loans | monthly | ≤ 3 per realm |
| Houses | yearly | ≤ 8 |

Expected: well under 1 % of a sim-year. Measured with `timeab` at the end, as in chunk 1.

## Build order

The whole chunk is built in one go on `sim/why-wars`, one commit per phase, with no pause
between phases. Stops happen only for decisions that are the user's.

1. **Claims on land.** Data, seeding from owner chains, making, renewing, inheriting, fading;
   the reconquest casus belli and the opinion term; Chronicle lines; the realm and town
   dossiers.
2. **War aims and peace terms.** Aims at declaration; "aim met"; terms by aim; reparations as
   a debt record (paid, no defaults yet); hostages; crown and faith terms; harshness and
   renunciation; declaration and treaty prose; the war dossier.
3. **Town memory.** Data, writes from captures, razings, sieges and cessions; loyalty, sieges,
   gates, revolts; Chronicle lines; the town dossier.
4. **Debt between crowns.** Loans, lenders, interest, arrears, defaults, the `debt` casus belli,
   banking houses, house failures; the realm dossier and the statistics series.
5. **Calibration and speed.** Twelve worlds against main; the gates; `timeab`; the design
   results recorded here.

## Decisions

The user's choices, recorded when made:

1. **Lenders: realms and banking houses.** Realms lend from the Bronze Age; banking houses
   appear from the Medieval Age and can fail when a crown defaults on them.
2. **Crown wars: personal union.** A won `crown` aim crowns the victor's ruler in the loser's
   realm too, through the personal unions in `dynasty.js` (`civ.flags.union`). The two realms
   stay separate under one ruler and may split again at a later succession. For a restoration,
   the exiled house is restored instead (the existing restoration path).
3. **Holy wars: the crown converts.** A won `faith` aim makes the victor's faith the loser's
   state religion. The towns keep their own faith and convert slowly, so unrest follows.
4. **Mythic peoples' memory: now.** Each people remembers for its own span, for both a town's
   memory (by the town's main people) and a realm's claims (by the realm's people). The myth
   module answers `memoryRule` and `claimRule`; at mythLevel 0 it answers null, so Historical
   worlds keep the defaults and stay byte-identical without the myth module.

   | People | Grudge | Gratitude | Claim | Claim on a founded town |
   | --- | --- | --- | --- | --- |
   | Humans | 40 | 25 | 60 | 120 |
   | Dwarves | 250 | 60 | 300 | 500 |
   | Elves | 200 | 200 | 250 | 400 |
   | Orcs | 25 | 12 | 35 | 70 |
   | Halflings | 25 | 50 | 50 | 100 |
   | Lizardfolk | 60 | 15 | 80 | 150 |

   Years, as e-folding times. Humans and orcs forget within two generations, dwarves keep a
   grudge for centuries, and elves remember both slights and kindnesses for lifetimes of men.
   The halfling and lizardfolk rows were not in the question and are a first guess: halflings
   remember kindness longer than slights, lizardfolk the reverse.

Defaults taken without a question (say if any should change):
- Hostages are part of the chunk, as the Deep Dive's idea lists them.
- The war-share governor stays, so the amount of war in the world is not a target.
- Claims on land are kept for realms only. Peoples claiming towns where their kin live belongs
  to chunk 8.
