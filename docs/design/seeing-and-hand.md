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
- **A war watch.** A watched war's chip carries a war card (each side's leader and allies, towns
  taken and razed, its fallen, its aim, the latest battle), and opens the dossier, which gains the
  same at a glance above the score over time it already charts. The front is shown on the map
  while the war is watched or selected.
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

Nothing here changes what happens in a world. One small record is kept, as bookkeeping only: **the
acts of the hand** (`world.sys.hand`), by a new observer system that reads the world and never draws
on its chance. (A war's score over time is already kept by the history ledger, `sim/ledger.js`, and
charted in the war's dossier as "The course of the war"; nothing new is needed for it.)

So a world with this chunk runs the same history as one without: a check compares them with the
record left out.

## Gates

- `npm test`, `--trial` at myth level 2, the 300-year Mythic trials, the keyframe and cohort checks.
- **Same history** (`headless --hand-check`): a world run twice with the same scripted acts, once
  without the hand's observer (not even imported), must serialise identically, leaving out the
  observer's record, the Chronicle and what reads it (the yearly history and statistics, the
  annals), and every field that points into the Chronicle by entry number (an effect's or a heat's
  source, a war's declaration, a band's last raid, the tallies: fields named …seq, src, hsrc,
  tally), since each report line shifts those numbers.
- Speed: at most +0.5 % per sim-year (the observer works only around acts). Save: at most about
  55 KB (the record keeps 150 acts, the oldest folded).

## Data

### The acts of the hand: `world.sys.hand`

```
acts: [{ id, seq, tool, grp, kind, day, x, y, r, pts, tgt | a, b, str, land, name,
         m0: { m: M, w: W } (before), m1: { m: M } (right after),
         end, gen: { day, m: M, w: W } once reported, endDay, genDay, eff }]   (the last 150)
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
  the sky 1 year (a harvest: rain's soil water is back to the world's within two), catastrophe 2
  years, life 5 years, peoples and fate 5 years, the uncanny 5 years. The first report also tells
  what the act did at once (right after against right before).
- **Folding:** the newest 40 acts keep every measure; an older act with both reports in keeps only
  its changes in the measures its power is for (at once, at its end, a generation on), which is all
  the Lessons read.
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

It reaches you as a Chronicle line (category Divine Hand) and a toast (decision 3) that open the
act's record, and is kept on the act for the Hand tab and the Lessons page. (The deed card is gone
by then; the report is its follow-up.) Each report leads with what the power is for: soil, harvests
and food for the sky; herds, plants and fish for life; people and towns for catastrophes; stability,
legitimacy and the ruler for fate (and a few powers their own: a plague's people, enlightenment's
inventions).

### The war watch

- **The war card:** a watched war's chip carries, as its card, each side's leader and allies, towns
  taken and razed, fallen and aim, and the latest named battle; clicking it opens the dossier, where
  "Each side" tells the same above "The course of the war" (the score over time, already charted).
- **The front on the map** (decision 4): while the war is watched or selected, the two sides'
  realms are outlined and faintly washed in their leaders' colours, the border between the two
  sides is drawn as the front (a dark band in the two colours' alternating dashes), sieges under way
  are ringed, and a selected war's battles and towns taken show as today.

### The hand on the map

A map mode, "The hand": the land muted, each act still at work ringed at its spot (or around its
town or realm) in the power's tone (boon, bane), labelled with the power and the time left; a
realm or town under a divine timed effect marked with its label. Clicking a ring opens the act.

### Lessons of the hand

A page in the Hand tab (decision 1), beside your acts newest first, with a card per power you have used:
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

- **An act's record** (the Inspector): the power, the place, the strength, the before and after,
  and both reports with their numbers.
- **The war card**, the dossier's score chart, the front on the map.
- **The hand** map mode; **Lessons of the hand** (decision 1).

## Saves, keyframes and old worlds

An old world has no `sys.hand`: its acts before the load have no records (the log of interventions
keeps no measures).

## Performance

The observer measures only around acts: a brush of a few hundred tiles twice, then twice more years
later; nothing per tile per month. The front is traced from the border grid, cached until borders
change.

## Build order

One go on `ui/seeing-and-hand`, a commit per phase, stopping only for the user's decisions:

1. **The war watch.** The war card, "Each side" in the dossier, the front on the map.
2. **What came of it.** The observer, the measures, the reports, the deed card's follow-ups.
3. **The hand on the map, and the act's record.**
4. **Lessons of the hand.**
5. **Checks:** the same-history gate, speed, save size, the twelve worlds (unchanged), then the Ledger
   and the Deep Dive.

## Decisions

The user's choices, recorded when made (2026-10-27):
1. **Lessons and the acts: a new Hand tab**, in every world (Legends appears only in Mythic and
   Legendary worlds; the powers are in all of them).
2. **Reports: when an act's work is done and a generation later** (25 years).
3. **Notices: a Chronicle line and a toast**, and on the act's deed card; never a pause.
4. **The front: while a war is watched or selected.**

## Results (2026-10-27)

Built in one go on `ui/seeing-and-hand`: a commit per phase, then wording and record-size fixes
from the checks.

### The same history

- **With acts:** `headless --hand-check`, a world run twice with the same scripted powers (rain,
  meteor, herds, a blessing; then drought, an incited war and a refused act), once without the
  observer, gives the same history on small and medium worlds, 60 and 120 years, at myth levels 0
  and 2. The first runs differed only in numbers that point into the Chronicle (each report line
  shifts them: an effect's or a heat's source, a war's declaration, a band's last raid, the
  tallies), which the check now leaves out.
- **Without acts:** a world with no act of the hand is identical to main's (the atlas world to Year
  500, every sampled number the same), so the twelve-world comparison is unchanged and was not rerun.

### Gates

All pass: `npm test` (determinism with and without the myth module, rewind, save and load),
`--trial` at myth level 2 (random acts of every kind, saved, reloaded and replayed), the 300-year
Mythic trials (seeds deep, trial, amber), the keyframe check, the cohort check and the new
`--hand-check`.

### Speed

`timeab` from Year-900 saves made on main, 100 years, 3 rounds: Historical −0.6 %, Mythic 0.0 %
(noise): the observer works only around acts, and the front and the hand's rings only while shown.

### Save

Without acts, nothing. With them, about 640 bytes for each of the newest 40 acts and about 270 for
each folded older one: about 55 KB at the most (150 acts), 15 to 20 KB for a few dozen.

### What the reports teach

From a test of seventy acts and a few dozen more: rain lifts the soil's water at once (0.25 to 0.30
in one test) and much of it is gone within two years, so the sky now reports after one harvest;
herds jump at once (+15 %) and five years later can stand below the world's change (−14 % against
−7 %); a blessed ruler may still be off the throne within five years; a meteor's town is gone, its
fish thriving a generation on.

### Checked in the browser

A world at Year 300 with five acts: the Hand map mode (rings with "Herds · 5 yr left"), the reports
arriving in the Chronicle 30 years on, the Hand tab (acts newest first; Lessons with a card per
power), and a war's dossier ("Each side") with its front drawn on the map. No console errors.
