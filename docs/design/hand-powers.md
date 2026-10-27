# The hand's powers, tuned (after the powers' audit)

The powers' audit (`tools/power-audit.mjs`; the page "Hand Powers Audit") tried every power at
light, middling and full strength on copies of fifteen worlds (five seeds, two of them Mythic, at
Years 150, 500 and 850), 1,922 trials, each measured against an untouched copy of the same world.
The great catastrophes were lopsided: a falling star or a raised volcano devastates at any size,
while the powers of water and weather barely touched people. Two terrain powers drowned towns
without proper warning, and the act record measured only the clicked tile for catastrophes.

## Decisions (2026-10-27)

All ten fixes, with natural quakes, waves and floods changed too; the fault's lift capped at about
30 m; wildfire reaching into towns.

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
10. **Wildfire.** A fire that burns next to a town (within a tile of it) now burns into it once
    per fire: buildings, stores and a few percent of its people, scaled by how dry the land is.
    This holds for natural fires too, which before reached a town only through its own tile.

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

### Checked in the game

Storm's forecast over land reads "A tempest would break · Ziriankee (370) in its path"; raised at
full fury, the tempest killed 15 of Ziriankee's 374 and the Chronicle told it ("For a day and a night
a god-sent tempest raged over Ziriankee, killing 15"). Lower's forecast gives the people at risk
(severity 3); Raise Island beside a shore says it would rise only further out; a 9.5 at sea forecasts
its wave. No console errors.
