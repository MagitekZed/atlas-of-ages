# Character — design

Chunk 4 of the deeper-simulation plan (the Deep Dive, "the work in chunks"): **personality**,
**skills**, **body and health** and **ambitions**, for the notable people only: rulers and their
heirs, the commanders of armies, and the great people. Thousands of records, never millions.

Today a ruler carries one to three of eighteen named traits (wise, cruel, warlike, mad …), each a
switch that other systems read: a warlike ruler multiplies the appetite for war by 1.9, a cruel
one adds to the chance of razing a town. A commander is a name and one skill number. A great
person does one deed and dies of age. Nobody wants anything, and nobody grows.

After this change:
- **Temperament.** A notable has a temperament: six numbers that the named traits are read from.
  Decisions weigh them smoothly, and the Chronicle says why a ruler chose war, peace or reform.
- **Skills.** A notable has skills that grow with age and use: war, diplomacy, stewardship, intrigue
  and learning. Competence shows in results.
- **Body and health.** A notable has a body: wounds from battle (a lost eye, a lame leg), lasting
  illness, madness that can come late in life, and a richer account of how they died.
- **Ambitions.** A notable has an ambition: a goal (take a town, avenge a father, seize the throne,
  write a masterpiece) that bends their choices until it is met, abandoned or dies with them.

## Goals and non-goals

- **Goals.**
  - Decisions made by character, explained in the Chronicle.
  - Competence that changes outcomes: a gifted steward fills the treasury, a master of intrigue
    survives plots, a great captain wins battles.
  - Wounds, illness and madness that change reigns and campaigns.
  - People with goals, so events follow from someone wanting something.
- **Non-goals.**
  - Family trees, lines of succession, kinship (chunk 9).
  - Court factions and estates (chunk 7). Ambitions here are personal, not a faction's demands.
  - Character for ordinary townsfolk.

## Rule: societies vary

| Rule | Default here | Later variations (examples) |
| --- | --- | --- |
| **How people are raised** (`temperRule`, first) | A realm's own traits lean its people's temperaments (an aggressive people breeds bolder rulers) | A faith that prizes mercy; Mythic peoples' natures (elves patient, orcs bold) |
| **What a ruler may want** (`ambitionRule`, first) | The list under "Ambitions", weighted by temperament | Laws of succession that tempt heirs (chunk 9); faiths that demand crusades |

## Gates

As in chunks 1 to 3:
- `npm test`, `--trial` at myth level 2, the 300-year Mythic trials and the keyframe check.
- At mythLevel 0, a world with and without the myth module stays byte-identical.

Calibration across the twelve worlds against main: population, realms, towns, wars, time at war,
reign length, coups and assassinations, wars started by ambition.

Speed: at most +1 % per sim-year. Rulers and figures number in the hundreds; everything is monthly
or rarer. Save: at most +100 KB at Year 1000.

## Data

### Temperament: `person.tp`

Six numbers from 0 to 1, rolled at birth:
- `amb` ambition
- `mer` mercy (low is cruelty)
- `pie` piety
- `gre` greed
- `hon` honour
- `bol` boldness (low is caution)

The named traits stay as the labels the dossier, epithets and the events read. A trait is held when
its temperament is extreme (cruel at mercy under 0.2, warlike at boldness and ambition over 0.7,
and so on). The rare traits (mad, brilliant, foolish, charismatic, scholarly) stay rolled as they
are, because they are not temperaments. So a world's mix of named traits stays about as it is.

### Skills: `person.sk`

Five numbers from 0 to 1: `war`, `dip` (diplomacy), `ste` (stewardship), `int` (intrigue), `lea`
(learning).
- **At birth:** rolled low, leaning by temperament and traits (a scholarly ruler learns).
- **With age:** each grows toward its ceiling, fastest at 20 to 40.
- **With use:** war through battles, stewardship through years on the throne, diplomacy through
  treaties, intrigue through plots survived.
- **In old age:** a little is lost after 60.

A commander's existing `skill` (0.8 to 1.5) becomes `0.8 + 0.7 × war`, so battles read the same
number.

### Body: `person.bd`

`{ wounds: [code], ill: code|null, mad: day|null }`:
- `wounds`: lost eye, lost hand, lame, scarred.
- `ill`: a lasting illness (wasting, falling sickness, the shaking).
- `mad`: since when the person has been mad.

### Ambition: `person.am`

`{ k, t, since, by }`:
- `k`: the goal.
- `t`: its target: a town, a realm, a person, a faith or a work.
- `by`: the year it is given up if not met.

Met, failed or abandoned ambitions go to `person.done` (at most 4).

Where they live:
- **Rulers:** on `civ.ruler`, and they go with the ruler into `rulerHistory`.
- **Heirs:** on `ruler.heir`, carried over when the heir is crowned.
- **Commanders and great people:** on the figure. A plain commander gets them when made, and
  carries them if promoted.

## Mechanics

### Temperament in decisions

The places that read named traits today read the temperament instead. Each is calibrated so an
average person gives today's average result:

| Decision | Reads |
| --- | --- |
| Appetite for war (`war.js declarations`) | ambition and boldness up, mercy and caution down; skill at war up |
| Spurning a beaten foe's envoys (`refusal`) | low mercy, low honour, ambition |
| Razing a taken town | low mercy |
| Breaking a pact (`betrayal`) | low honour |
| Taxes (`targetTax`) | greed |
| How others see the realm (`targetOpinion`) | honour, mercy, the ruler's diplomacy |
| Coups and assassinations | the ruler's intrigue, and the realm's mood |
| Reforms (`evaluateGovernment`) | ambition and boldness, against caution |
| Battle plans (`choosePlan`) | the commander's boldness (feigned retreats and flanking charges) against caution (the line, the shield wall) |

**Why, in the Chronicle.** When a ruler's temperament or ambition tipped a decision (its weight
was at least a third of the choice), the line says so. For example: "Ambitious and restless,
King Arkel II marched on Varn"; "Merciful to a fault, Queen Ilsa spared the town"; "Bent on
avenging his father, …".

### Skills in results

| Skill | Effect |
| --- | --- |
| Stewardship | the realm's income × (0.9 + 0.2 × skill) |
| Diplomacy | others' opinion of the realm, up to +10; treaties accepted more readily |
| Intrigue | coup and assassination risk × (1.4 − 0.8 × skill); plots it brings against rivals succeed more often |
| Learning | research × (0.95 + 0.1 × skill) |
| War | a ruler who leads in person fights as a commander with that skill (decision 2: likelier the earlier the age and the smaller the host) |

The ext `researchMul` and the civ module's income read these through small hooks, so the effects
are counted once.

### Body and health

- **Wounds.** A commander in a lost battle risks a wound (8 %, 15 % if routed); a winner 3 %. A
  ruler leading in person carries the same risk.
  - A lost eye or hand costs 0.1 of war skill.
  - Lame costs boldness in the field.
  - Scars are only a story.
  - A wounded ruler's epithet may come from the wound ("the One-Eyed").
- **Lasting illness.** 1 % a year after 40, more in early eras. It doubles the yearly hazard, takes
  a skill's growth away, and its name is told when the person dies.
- **Madness.** From age 50, 0.2 % a year, more with the falling sickness. A mad ruler takes the
  `mad` trait (as today) and decides erratically: temperament is rerolled each year.
- **How they died.** Today's causes (old age, illness, battle, assassination), told with the
  illness or wound that took them: "of the wasting sickness that had plagued her for a decade".

### Ambitions

A ruler, a heir, a commander and a great person each hold at most one. A new one is drawn when
the old is resolved, weighted by temperament, from those that fit:

| Who | Ambition | Fits when | Bends | Met when |
| --- | --- | --- | --- | --- |
| Ruler | **Take a town** | the realm claims a town another holds | appetite × 2 against its holder | the realm holds it |
| Ruler | **Avenge** | a parent or the realm was wronged by a living realm (a lost war, a slain heir, a sacked capital) | appetite × 2.5 against it; spurns its envoys | a war won against it |
| Ruler | **Unite the people** | another realm of the same people borders it | appetite against it | the realm conquers or absorbs it |
| Ruler | **Convert a neighbour** | pious, a neighbour of another faith | holy war × 1.5 | the neighbour's crown converts |
| Ruler | **Build a great work** | no wonder in the realm | wonder building × 2 | a wonder finished |
| Ruler | **A golden age** | learned or a steward | research and building | a golden age begins |
| Heir | **Seize the throne** | ambitious, honour low, a ruler who lives long | a plot (decision 4) | crowned early |
| Commander | **Glory** | bold | seeks battle | a named victory |
| Commander | **Power** | ambitious, low honour, a standing army | a coup (with chunk 2's coups) | seizes the throne |
| Great person | **A masterpiece**, **a discovery**, **a voyage**, **a fortune**, **slay a beast** | by kind | the deed already made today, now told as fulfilment | the deed |

An ambition not met by its `by` year (10 to 30 years) is given up. When the person dies it dies
with them, or passes to an heir who swore to finish it: half the time for "Avenge", "Take a town"
and "Unite the people". Met ambitions can give an epithet ("the Avenger", "the Uniter").

**Plots** (decision 4). An heir set on the throne, or a commander set on power, may act after 3
years. Each year the chance is a few percent times their intrigue, against the ruler's intrigue.
- **Success:** a usurpation (heir) or a coup (commander), through the existing paths.
- **Failure:** prison, exile or death, and the plotter's realm is shaken. Rare by design.

## Events and heat

- `person.why`: no separate entry; the reason is folded into the decision's own line.
- `ambition.met` (2, or 3 for a ruler's conquest or vengeance), `ambition.failed` (1),
  `ambition.sworn` (1, a ruler's vengeance or crusade only).
- `person.wounded` (1, a ruler or a great commander), `person.mad` (2, a ruler going mad).
- `plot.usurp`, `plot.coup` (3), `plot.foiled` (2).

Rate-limited like the people news.

## Interface

- **Ruler dossier.** Temperament as six bars (with the named traits it gives), skills as five, body
  (wounds, illness, madness), the ambition and those met or failed.
- **Figure dossier** (commanders, great people): the same.
- **Realm dossier.** Under Ruler: the heir's ambition when it is the throne.
- **War declarations and treaties** carry the ruler's reason.

## Saves, keyframes and old worlds

People without the new fields get them at their first read, rolled from their named traits by
hash (no rng), so an old save loads without a draw and its rulers keep their traits.

## Performance

Monthly over rulers (one per realm); yearly over heirs and living figures (hundreds). Decisions
read a few numbers. Expected: well under 1 %.

## Build order

One go on `sim/character`, a commit per phase, stopping only for the user's decisions:

1. **Temperament and skills.** The data, growth, the decisions converted, the reasons in the
   Chronicle, the dossiers.
2. **Body and health.** Wounds, illness, madness, how they died.
3. **Ambitions.** Drawing, bending, meeting, failing, passing on; plots (decision 4).
4. **Calibration, speed and gates**, then the Ledger and the Deep Dive.

## Decisions

The user's choices, recorded when made:

1. **Temperament under the traits: yes.** Six temperament numbers per notable; the named traits are
   read from them, and decisions weigh them smoothly.
2. **Rulers in the field: the warlike ones, less as the ages advance and armies grow.** A bold ruler
   skilled at war may lead the realm's main army in person and risks wounds, capture and death. The
   chance falls with the era and the size of the host: nearly always for a Stone Age chief's war
   band, rarely for a Renaissance king's army of tens of thousands. By era: 0.9, 0.8, 0.65, 0.5,
   0.4, 0.15, then 0.03; by size: × 1 under 1,000 men, falling to × 0.3 at 20,000 or more; × the
   ruler's boldness and war skill.
3. **Who has ambitions: everyone notable.** Rulers, heirs, commanders and great people.
4. **Plots for the throne: yes, rarely.** An heir or commander set on the throne may plot after a
   few years; success is a usurpation or a coup, failure prison, exile or death.
