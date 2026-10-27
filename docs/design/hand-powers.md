# The hand's powers, tuned (after the powers' audit)

The powers' audit (`tools/power-audit.mjs`; the page "Hand Powers Audit") tried every power at
light, middling and full strength on copies of fifteen worlds (five seeds, two of them Mythic, at
Years 150, 500 and 850), 1,922 trials, each measured against an untouched copy of the same world.
The great catastrophes were lopsided: a falling star or a raised volcano devastates at any size,
while the powers of water and weather barely touched people. Two terrain powers drowned towns
without proper warning, and the act record measured only the clicked tile for catastrophes.

## Decisions (2026-10-27)

All ten fixes, with natural quakes, waves and floods changed too; the fault's lift capped at about
30 m; wildfire reaching into towns. After the twelve worlds (below): only the hand's fires burn into
the towns beside them for now; natural fires should too, but more gently, to be revisited.

## The fixes

1. **Earthquakes.** The share of a struck town that dies doubles: 0.4 × shaking^1.5 (was 0.2). An
   M9.5 takes about 40% of the town at its heart and about 10% of one halfway out; an M7.3 about
   28% of the town it strikes. An undersea quake of 7.5 or more raises a wave wherever it strikes
   (the rule that land lie within 8 tiles is gone; the wave's reach decides who it meets). Natural
   quakes and the forecast follow the same helpers (`quakeStrike`).
2. **Waves.** A wave drowns 0.5 × its strength of a struck town (was 0.25), with the harbour's
   +0.04 and the cap of 60% kept (`tsunamiToll`): the Tsunami power, undersea quakes, falling stars
   at sea and natural waves alike.
3. **Storms.** The hand's storms carry a might, 1 + 2 × fury (up to 3× at full): a cyclone, a
   blizzard or a sandstorm raised by the hand strikes towns that much harder, and a blizzard freezes
   herds that much faster. Over land that is neither desert nor frozen, Storm raises a tempest: a
   thunderstorm that strikes towns the way a cyclone does at landfall (natural thunderstorms still
   only kindle fires). Natural storms are unchanged.
4. **Floods.** Deaths three times higher: the Flood power 0.06 × depth (was 0.02), natural floods
   (0.012 + 0.048 × severity) × lowland (was 0.004 + 0.016), cap 0.24 (was 0.08). The ruined
   harvest and the silt stay.
5. **Alliances.** An alliance the hand forges cannot lapse for twenty years (`allyUntil` on both
   relations); war between the two still ends it.
6. **Raise Island.** Two causes, two rules. Beside a settled or claimed shore (a realm's land or a
   town's), the island leaves that shore at its height and keeps a strait of sea just below sea
   level, so a new isle never dams a bay into a hollow that fills as a lake over the town on it
   (`isleShore`; the forecast says so when the brush sits beside such a shore). Wild coast and the
   island's own new land do not count, so an island can still be grown click by click. And during play, a stretch of sea
   closed off from the ocean stays sea at sea level, a lagoon, instead of filling to its rim
   (`recomputeWater(world, { keepSea })`; world generation is unchanged).
7. **Lower.** Its forecast already named the town that would drown and after how many
   applications; it now also gives the people at risk and the severity Sink's does.
8. **The fault's lift.** A quake of 7 or more lifts one side and sinks the other by 0.0007 ×
   (M − 6.5) of elevation (was 0.004): about 30 m at M9.5 (was about 170 m).
9. **What came of it.** For a power that strikes a point (an earthquake, eruption, falling star,
   tsunami, storm, lightning, locusts), the act measures the reach its forecast draws (its ring, up
   to 12 tiles) and the towns the forecast names, not the clicked tile alone.
10. **Wildfire.** A fire the hand set (Wildfire, or Lightning's blaze) that burns next to a town
    (within a tile of it) burns into it once per fire: buildings, stores and a few percent of its
    people, scaled by how dry the land is. Natural fires still reach a town only through its own
    tile: given the same rule they drained Mythic worlds (below), and a gentler natural version is
    left for later.

## Build order

A. Quakes, waves, floods and the fault's lift (1, 2, 4, 8). B. Storms, blizzards and wildfire (3,
10). C. Island lagoon and Lower's warning (6, 7). D. Lasting alliances and reports over the reach
(5, 9). Then the audit again, the gates, twelve worlds against main, speed and save size.

## Results (2026-10-27)

### Gates

All pass: `npm test` (determinism with and without myth, rewind, the trial), the Mythic trial, the
keyframe and cohort checks, three 300-year Mythic trials (deep, trial, amber), and the hand check
with and without myth (the world's history identical with and without the observer, now that it
asks a point power's forecast for its reach).

### The powers, measured again

The powers' audit again on the same fifteen worlds (five seeds, Years 150, 500 and 850; medians):

| Power, at full | Before | After |
|---|---|---|
| Earthquake M9.5 on the largest town | its town −20%, reach −12% | its town −40%, reach −24% |
| Earthquake M9.5 3–5 tiles offshore | worst coast town −30%, coast −5% | worst −58%, coast −10% |
| Earthquake M9.5 9–14 tiles out | worst −23% | worst −41% |
| Tsunami, full height | worst −28%, 7 towns lose a tenth, coast −4% | worst −55%, 9, coast −9% |
| Storm over land | nothing | its town −8% (a tempest) |
| Storm over warm sea | worst coast town −3% | worst −8% |
| Flood, one click / held | −2% / −4% | −4% / −7% (worst town −9%) |
| Wildfire, held | worst town −2% | worst town −4% |
| Raise Island off a coastal town | town drowned in 4 of 15 worlds at full | 0 of 60 trials at any strength |
| Forge Alliance | 3 of 8 standing after 5 years | 6 of 6 |

A full blizzard still barely moves a year's numbers: it bites over days (herds −4–5% across its
area and food −6–16% after ten days in a test of four towns) and the temperate towns the audit
aims at thaw it quickly.

### Twelve worlds against main

The calibration matrix (twelve worlds to Year 1000, against main at d1dc8cd, which reproduces the
previous baseline exactly):

    Historical Y500   pop −7%   civs −3%   towns −0%  wars +3%   at war 0.163→0.154
    Mythic     Y500   pop −27%  civs +11%  towns −3%  wars −8%   at war 0.140→0.132
    Historical Y1000  pop +2%   civs −10%  towns +3%  wars −6%   at war 0.231→0.229
    Mythic     Y1000  pop −14%  civs +0%   towns −3%  wars +4%   at war 0.194→0.206
    smallest world at Y1000: 7 realms, 179 towns

Natural disasters to Year 1000, summed over the twelve: fire deaths 1.07 M → 4.24 M, flood deaths
130 k → 367 k, quake deaths 5.3 k → 10.9 k (wave and cyclone tolls move with chance: the main run
had an ocean meteor).

The Mythic drop was the fire rule, then applied to every fire. With only the fire-into-towns rule turned off, the six Mythic
worlds come out at +2% (Y500) and +2% (Y1000) against main. Fire deaths themselves are small (300–600 a
year in worlds of 3–5 million), but in a Mythic world at Year 300 fires struck towns 2.5 times a year
instead of 0.5 (mostly halfling towns in burnable grass), and each strike burns buildings and stores:
61 towns at Year 300 instead of 71. So the rule now holds for the hand's fires only; with it, the
six Mythic worlds are those +2% runs, and the six historical worlds, run again, are below.

The twelve worlds as merged (fire burning into towns for the hand's fires only):

    Historical Y500   pop +6%   civs −4%   towns +6%  wars +15%  at war 0.163→0.179
    Mythic     Y500   pop +2%   civs +3%   towns −1%  wars −31%  at war 0.140→0.111
    Historical Y1000  pop +9%   civs −15%  towns +2%  wars +11%  at war 0.231→0.264
    Mythic     Y1000  pop +2%   civs +1%   towns +2%  wars −1%   at war 0.194→0.199
    smallest world at Y1000: 7 realms, 179 towns

Fire deaths are back to main's (historical: 543 k → 545 k to Year 1000); flood deaths about four
times main's (53 k → 207 k), quake deaths 2.8 k → 7.3 k, and one great wave (741 → 15.6 k).

### Speed and save

Year-900 main saves, 100 years, three rounds: wall time −2.2% (historical) and −0.2% (Mythic) per
simulated year, within noise. A save 100 years on: 22.84 MB on main, 22.71 MB on the branch.

### Checked in the game

Storm's forecast over land reads "A tempest would break · Ziriankee (370) in its path"; raised at
full fury, the tempest killed 15 of Ziriankee's 374 and the Chronicle told it ("For a day and a night
a god-sent tempest raged over Ziriankee, killing 15"). Lower's forecast gives the people at risk
(severity 3); Raise Island beside a shore says it would rise only further out; a 9.5 at sea forecasts
its wave. No console errors.
