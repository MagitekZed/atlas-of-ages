# Seeing and the hand — design

Chunk 10 of the deeper-simulation plan (the Deep Dive, "the work in chunks"), from playtesting
(Dakota Barron, 2026-10-25): wars you can follow, and divine powers that report back on what they
did, so a player learns them by using them. Its four quick wins (the watch strip over the letters,
the pause chime and tab title, a per-visit desktop notification, the war chip's score) are already
live; this is the rest.

What the playtester asked:
- "It'd be cool to … be able to specifically watch a war in some way."
- "Sometimes I don't feel a connection between the divine powers (like releasing herds, making it
  rain, etc) and outcomes … more feedback to the user when using those powers, and it doesn't have
  to be immediate. But something over time that helps me learn what the powers can and can't do."
  Like a hammer: you feel how a harder hit drives the nail further, and learn that a careless
  swing bends it.
- "The tools are not a big part of my play because I can't tell what impact they really have."

Today a watched war is a chip with its score, and its dossier tells the sides, battles, towns taken,
losses, aims and terms, with a theatre map. An act of the hand raises a deed card (the tool, its
strength, a sentence, Undo) and a Chronicle line; nothing reports back later, so a player never
learns whether the rain fed the harvest or flooded the valley, nor whether a stronger rain did more.

After this change:
- **A war watch.** A watched war's chip opens a war card: the score over time, towns taken by each
  side, the losses on each side, each side's aim, the latest battle. The war's dossier gains the
  score over time. The front is shown on the map while the war is watched or selected.
- **What came of it.** Every act of the hand records what it touched when it was cast (the land,
  the towns, the realm), and measures the same things again when its work is done and a generation
  later, against the rest of the world over the same years. Each report is a short line: "The rains
  you sent on the steppe near Varn in Year 812: two years on, harvests there ran 22 % above where
  they stood (the world: +3 %); the herds grew 10 %."
- **The hand on the map.** A map mode that rings every act still at work, with its power and the
  time it has left, and marks the realms and towns under a divine blessing or curse.
- **Lessons of the hand.** A page that gathers your acts by power: how often used, how strong, and
  what typically came of it, by the kind of land and the strength chosen, and what the power was
  refused for. It teaches the powers through your own history: rain on wetland floods, rain on
  steppe feeds.

## Goals and non-goals

- **Goals.**
  - Wars that can be followed at a glance, with the front on the map.
  - Every act of the hand reporting back, twice, in plain numbers against the rest of the world.
  - A place that teaches each power from what it actually did, including what strength does.
- **Non-goals.**
  - Changing what any power does. No power is rebalanced here.
  - Predicting outcomes before an act (the previews already estimate deaths and targets).
  - A general history of the world's numbers (the Annals and Statistics have that).

## Rule: simulation untouched

Nothing here changes what happens in a world. Two small records are kept, as bookkeeping only:
- **A war's score over time** (`war.ledger.s`), sampled when it changes, by the war module.
- **The acts of the hand** (`world.sys.hand`), by a new observer system that reads the world and
  never draws on its chance.

So a world with this chunk runs the same history as one without: the determinism test compares
them with the records left out.

## Gates

- `npm test`, `--trial` at myth level 2, the 300-year Mythic trials, the keyframe and cohort checks.
- **Same history:** a world run with and without the hand's observer and the score samples
  serialises identically, those records left out.
- Speed: at most +0.5 % per sim-year (the observer works only around acts). Save: at most +50 KB for
  a world with a few hundred acts.

## Data

### A war's score over time: `war.ledger.s`

`[[day, score]]`: a sample whenever the score moves by 5 or more, or yearly while it holds; at most
120 (when full, every other old sample goes). Read by the war card and the dossier's chart.

### The acts of the hand: `world.sys.hand`

```
acts: [{ seq, tool, day, at: { x, y, r } | null, target: { kind, id } | null,
         strength, land: biome group of the spot, before: M, after: M,
         end: { day, m: M, w: W } | null, gen: { day, m: M, w: W } | null,
         endDay, genDay }]                                  (the last 300 acts)
refused: { toolId: { reason: n } }                          (why acts were refused)
```

`M` is a few numbers about what the act touched, by its target:
- **Land and its towns** (tools on a spot or an area): within the brush, mean rain, soil water,
  vegetation, herds and fish; the towns there, their people, food in store, harvest and unrest.
- **A town:** its people, food, harvest, wealth, health, happiness and unrest.
- **A realm** (and a ruler): its people, towns, treasury, stability, legitimacy, inventions known,
  wars under way, and whether the ruler still reigns.
- **Two things** (pair acts): both, and the opinion between them and whether they are at war.

`W` is the same measures for the whole world at that day, for comparison.

### When an act reports

- **When its work is done:** when the timed effect it set expires; else a span by power family:
  the sky 2 years, catastrophe 2 years, life 5 years, peoples and fate 5 years, the uncanny 5 years.
- **A generation later:** 25 years after the act.
- A continuous stroke of a power is one act (the log already merges strokes).

## Mechanics

### The observer

A system that runs late each month:
- On `toolApplying` (a new hook, emitted just before a power acts), it measures `before`; on
  `toolApplied`, `after` (the immediate result, so a meteor's deaths count).
- Each month it measures the acts whose `endDay` or `genDay` has come, with the world's measures.
- Refusals are counted by reason, for the Lessons page.

### The reports

A report names the act, the place and the year, and the two or three measures that moved most,
each against the world's change over the same years:
- "The rains you sent on the steppe near Varn in Year 812: two years on, harvests there ran 22 %
  above where they stood (the world: +3 %); the herds grew 10 % (the world: −1 %)."
- "The plague you loosed on Oskel in Year 640: a generation on, the town has 4,100 people, 38 % fewer
  than before (the world: +12 %)."
- "Your blessing on Queen Ilsa in Year 701: when it faded, her realm's stability stood at 0.78, up
  from 0.61; she still reigns."

It reaches you as a Chronicle line (category Divine Hand) and a toast (decision 3), and is kept on
the act for the deed card and the Lessons page.

### The war watch

- **The war card:** clicking a watched war's chip, or its dossier's head, shows the score over time
  as a line (each side's colour above and below the middle), towns taken by each side, the dead on
  each side, each side's aim, and the latest named battle.
- **The front on the map** (decision 4): while the war is watched or selected, the two sides'
  lands are washed in their colours, towns taken are marked (an arrow in the taker's colour), sieges
  under way ringed, and the war's battles shown as today.

### The hand on the map

A map mode, "The hand": the land muted, each act still at work ringed at its spot (or around its
town or realm) in the power's tone (boon, bane), labelled with the power and the time left; a
realm or town under a divine timed effect marked with its label. Clicking a ring opens the act.

### Lessons of the hand

A page (decision 1) with a card per power you have used:
- How often, when last, and at what strengths.
- What typically came of it at its end and a generation on: the median change of its main measures
  against the world, split by the kind of land (wetland, steppe, forest, desert, hills, coast …) and
  by strength (light, middling, strong).
- What it was refused for, and how often ("No town there", "The realm already has an heir").
- Its acts, newest first, each opening the act's own record.

## Events and heat

- `hand.report` (2): an act's report, at its end and a generation later (decision 3).
No heat; reports never start events.

## Interface

- **Deed card:** an act's card gains its reports as they come ("What came of it").
- **An act's record** (the Inspector): the power, the place, the strength, the before and after,
  and both reports with their numbers.
- **The war card**, the dossier's score chart, the front on the map.
- **The hand** map mode; **Lessons of the hand** (decision 1).

## Saves, keyframes and old worlds

An old world has no `sys.hand`: its acts before the load have no records (the log of interventions
keeps no measures). Its wars rebuild a coarse score line from their battles and towns taken.

## Performance

The observer measures only around acts: a brush of a few hundred tiles twice, then twice more years
later; nothing per tile per month. The score samples are a comparison a month per war.

## Build order

One go on `ui/seeing-and-hand`, a commit per phase, stopping only for the user's decisions:

1. **The war watch.** Score samples, the war card, the dossier chart, the front on the map.
2. **What came of it.** The observer, the measures, the reports, the deed card's follow-ups.
3. **The hand on the map, and the act's record.**
4. **Lessons of the hand.**
5. **Checks:** the same-history gate, speed, save size, the twelve worlds (unchanged), then the Ledger
   and the Deep Dive.

## Decisions

The user's choices, recorded when made.
