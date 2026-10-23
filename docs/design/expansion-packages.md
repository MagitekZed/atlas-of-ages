# Expansion work packages
Each package owns the files listed under **Owns**; nobody else edits them. Shared contracts: `docs/design/expansion-contracts.md`.

## WP1 Event Deck & Living History (sim/events)

**Owns:** src/sim/events/index.js (new; system {id:'events', order:84}), src/sim/events/engine.js (new), src/sim/events/heat.js (new), src/sim/events/governor.js (new), src/sim/events/annals.js (new), src/sim/events/ages.js (new), src/sim/events/character.js (new), src/sim/events/ruins.js (new), src/sim/events/fate.js (new), src/sim/events/prose.js (new), src/sim/events/data.js (new), src/sim/events/decks/early.js (new), src/sim/events/decks/town.js (new), src/sim/events/decks/realm.js (new), src/sim/events/decks/pair.js (new), src/sim/events/decks/land.js (new), src/sim/events/decks/world.js (new), tools/events-report.mjs (new)

**Proposals:** events:event-engine, events:early-age-deck, events:city-character, events:urban-life-deck, events:world-ages-black-swans, events:news-value-annals (sim side), events:diplomatic-incidents (should), events:ruins-resettlement (should, events side), events:fate-deck-tool (should, sim side)

**1. Engine (engine.js).** Schedule checks over core getEvents(scale):
- town: each live settlement once a year, on day (s.id*37)%360
- realm: each live civ, on day (civ.id*53)%360
- pair: yearly for contacted pairs with relation.border>0, on day (a*7+b)%360
- land: yearly per continent feature, on day 90
- world: day 180

Each check does exactly one world.rng.next() against min(0.5, sum of weights), plus one weightedIndex pick only when it fires. Before summing, drop defs whose minMyth/maxMyth or era bounds do not match. Cooldowns live in sys.events.cd['id|subject'] and are pruned yearly. heat.js keeps sys.events.heat['tag|subject'], decaying ×0.9 a year and pruned below 0.05. governor.js gives each family a budget of imp≥2 entries per decade; once over it, that family's weights are halved for the rest of the decade. Track counts{id}, byCentury and families. All effects go through core addEffect; structural changes go only through kernel functions or published exports (WP3 splitCiv, WP4 createPlague and foundReligion).

**2. Decks.**
- early.js (Y0–400, era ≤1, at least 10 defs):
  - named great beasts per continent in sys.events.beasts (a 64-tile range sample; yearly population from f.herb minus hunting pressure)
  - extinction (imp 3, with a foodYield effect on hunter towns)
  - domestication (grantTech via civ/tech.js)
  - cattle raids (addOpinion/grievance, feeding the revenge casus belli)
  - standing stones (s.traits 'sacred site' plus an effect)
  - shaman vision becoming a faith (foundReligion)
  - first boats, hunting-ground feuds, herd migrations
- town.js (at least 14 defs): great fire (odds from crowding, dry season, biome wood and protecting techs; 'rebuilt in stone' trait), bread riot, guild revolt (Free City via splitCiv at era ≥3), boom, bust (on the depositExhausted hook), great fair, quarantine (plagueDose effect 0.2), siege endured, plague panic, flood rebuild, pilgrim influx, festival.
- realm.js (at least 8 defs): treasury crisis choice (debase, borrow or raise taxes, as civ effects chosen by ruler traits), court intrigue, succession scandal, royal hunt, great census, great road, famine relief, flight of scholars.
- land.js: continental dark age, golden age, Age of Contact (crop-exchange effect).
- world.js:
  - ages: 1–2 at genesis, re-rolled every 250–500 years or by triggers
  - at least 5 black swans: systems collapse (stability −0.25 and trade ×0.5 effects on 3+ civs, plus a bandSpawn rate boost), great comet, pandemic of contact (on the routeCreated hook for the first intercontinental sea route; createPlague lethalityMul 3), great river flood, a messiah figure
  - no two black swans within 200 years; rates ∝ params.fortune; worldAges param toggles ages
- ages.js registers the rates, warAppetite and routeValue providers and exports currentAges(world) for the HUD.

**3. City character (character.js).** This is the sole writer of s.traits, s.epithet, s.legend and s.hist:
- legend on settlementCreated
- 1–2 specialties on tierChanged to tier ≥3, from s.flags.pot and buildings, as permanent settlement effects capped at ±15%
- epithets earned from s.hist counters fed by siegeEnded, fireEnded, quake, plagueEnded and settlementTransferred, and lost when contradicted

**4. News value (annals.js).** Register core setNewsFilter:
- a succession in a realm that had one in the last 15 years, with no epithet or crisis, becomes imp 1 with fold
- unnamed battles under a casualty threshold get fold
- non-aggression and trade compacts get fold

At year%10===0, write one imp-2 digest entry (key 'annals.decade') per civ with 3 or more folded items. Export annalKeyLabel and EVENT_FAMILIES for the UI.

**5. Should items.**
- decks/pair.js: at least 8 incidents (border skirmish, insulted envoy, hostage exchange, royal visit, embassy, spy scandal, embargo, refugee dispute, assassination plot), at most 1 per pair per 8 years, moving only opinion, trust and grievance. A royal marriage calls WP3 arrangeMarriage when it exists.
- ruins.js: siteBonus and settleName providers ('New X', or the old name for kin); excavation near library towns at era ≥4 (culture effect, chance of lost tech); looting (wealth, banditry heat), all through updateSite.
- fate.js: eligibleEvents (pure); nudge (effect 'fate:<id>' ×5 weight for 20 years); invoke (once per subject per 5 years), registered as entity tool 'fate' whose preview returns cards.

**6. Chronicle.** Every entry goes through chronicle/record with key 'event.<id>', a ref, and cause (the parent seq when chained).

**7. Reporting.** system.report() covers families per century, imp≥2 per year (overall and Y0–250), the year of the first imp≥4 entry, the war share of imp≥2 entries, the p90 gap between imp≥3 entries, and a yearRecord provider {ev:{family:n}}. tools/events-report.mjs runs 5 seeds × 1000 years.

**Acceptance:**
- imp≥2 entries 2–40 a year overall, and at least 1.5 a year in Y0–250
- first imp≥4 before Y60 in at least 4 of 5 seeds
- war under 40% of imp≥2 entries after Y250
- routine successions under 20% of Nations imp≥2 entries
- world population falls 10% or more within some 50-year window in at least 2 of 5 seeds
- at most 4 ms per year
- save → load → continue hash is identical

**Needs contracts:** core/events.js registry and def/ctx contract | core/effects.js addEffect + SETTLEMENT_MOD_KEYS | core/ext.js providers: rates, warAppetite, routeValue, siteBonus, settleName, yearRecord | chronicle key/ref/cause/fold + setNewsFilter + prune retention | hooks: settlementCreated, tierChanged, siegeEnded, fireEnded, quake, plagueEnded, settlementTransferred, depositExhausted, routeCreated, eventFired | core/sites.js updateSite + ruin data shape | settlement fields traits/epithet/legend/hist (sole writer) | params fortune, worldAges | published exports: WP3 splitCiv/grantTech/arrangeMarriage, WP4 createPlague/foundReligion | tools contract: entity target + preview.cards | system.report()

## WP2 Roaming Powers: bands, hordes, pirates & beasts

**Owns:** src/sim/bands/index.js (new; system {id:'bands', order:82}), src/sim/bands/engine.js (new), src/sim/bands/move.js (new), src/sim/bands/combat.js (new), src/sim/bands/hire.js (new), src/sim/bands/hunts.js (new), src/sim/bands/names.js (new), src/sim/bands/prose.js (new), src/sim/bands/tools.js (new), src/sim/bands/kinds/outlaws.js (new), src/sim/bands/kinds/pirates.js (new), src/sim/bands/kinds/companies.js (new), src/sim/bands/kinds/hordes.js (new), src/sim/bands/kinds/beasts.js (new), src/sim/bands/kinds/dragons.js (new), src/sim/bands/kinds/undead.js (new, should), src/render/bands.js (new layer + fx types), src/ui/views/band.js (new view, search source, context items, director source), src/ui/css/bands.css (stub created by lead)

**Proposals:** events:non-state-actors, mythic:creature-framework, mythic:dragons, mythic:confronting-monsters, mythic:myth-tools (summon_beast, slay_beast, tame_beast), mythic:undead (should)

You own every roaming non-state actor, all built on the kernel band shape (core/bands.js).

**1. Engine.**
- Daily movement only for bands in roam, raid or return state:
  - land: findPath, cached per target by versions
  - sea: pirates and krakens
  - flyers: a straight line with wobble
- Monthly interactions:
  - raids on settlementsNear: damageSettlement plus loot, scaled by settlementMods(s).raidRisk
  - caravans and ships: removeEntity on caravans; route pressure kept in world.cache.bandPressure and fed to the routeValue provider; call WP4 breakRoute after 3 raids
  - garrison fights and army clashes, resolved here with kernel damageArmy; emit the battle hook with kind 'band' or 'beast'
- Hunts: a civ raided in the last 3 years with power at least 1.5× the band's raises a hunt army (createArmy with flags.hunt = bandId and warId null). WP2 moves and resolves it, and disbands it through removeArmy plus the armyDisbanded hook.
- Caps: at most 40 people-bands, and their total strength at most 3% of world manpower.

**2. Historical kinds (always on; banditry param × rates 'bandSpawn').**
- bandits: spawn on devastated, low-loyalty land after wars and in dark ages
- pirates: spawn on busy sea lanes next to weak navies
- free companies: form from the disbanded armies of rich realms. Realms at war hire them: band becomes army with flags.merc, paid monthly from the treasury. Unpaid companies turn and may seize a town, founding 'the Free Company of X' via createCiv and transferSettlement.
- steppe hordes: come from horde governments or emergence on the steppe, target the richest sedentary neighbour, and turn a captured city into a horde state

**3. Beasts (kinds/beasts.js, dragons.js), only when mythOn(world).**
- Capacity K = monsterAbundance × (world.sys.myth?.weave ?? 1) × land/800, at most 60, × rates 'beastSpawn'.
- Spawn on wild tiles at least 6 tiles from owned land, by a habitat table.
- Kinds: wyvern, troll (raids on winter nights), giant, treant (wakes when forest is cleared), kraken (sinks ships), behemoth (seasonal migration).
- Dragons:
  - pinned lair sites, sleeps of 20–120 years, raids every 4–18 months on the target that maximises wealth^0.7/distance within 35 tiles; the hoard grows from raids
  - power grows with age, an Elder after 500 years, clutches when two wake nearby, pacts with greedy or craven rulers
  - the eruption hook wakes fire drakes
  - when slain: the hoard goes to the slayer's treasury, plus prestige and a chance of a golden age; dragonbone is placed on the lair tile, the lair site is renamed 'the Bones of X', and the slayer becomes a hero figure (addFigure, epithet Dragonsbane)
- Responses: hunt, hero (the heroTarget provider for culture.js deeds, plus direct attempts), tame (reads the WP5 mod key 'taming'; a tamed beast trails an army and adds a battle provider bonus of +0.5·power), and pact.
- Undead (should): grave sites from great battles rise as decaying undead hordes; power is capped relative to world population.

**4. Tools.** summon_beast (myth group, mythLevel 2), slay_beast and tame_beast (entity tools), each with a preview showing the odds.

**5. render/bands.js.**
- 'units' layer glyphs per BAND_KINDS: campfire banner, black sail, company banner, horse-tail standard; beasts as cached 2-frame sprites
- lairs at z ≥10, with bones and a gold glint
- labels for named bands at z ≥5
- raid arrows for the last 2 years, when the mode is 'monsters' or a band is selected
- hits with kind 'band'
- registerFxType for raid, dragonfire (breath cone and embers), slay and summon

**6. ui/views/band.js.**
- band view: kind, epithet, leader, strength or power bar, morale, loot or hoard, lair link, employer or tamer, raids and kills listed from chronicle refs, and a MiniChart from WP6 series(world,'b',id) when present
- a search source for living and archived bands
- context items
- a director source covering dragon raids, horde marches and pirate sackings

**7. Records.** Chronicle refs {k:'band'}; yearRecord provider {bands:{kind:n}}; bandCreated, bandDestroyed and bandRaid hooks; sys.bands.archive (cap 200).

**8. Reporting.** report() covers bands per kind per century, raids and kills, and towns at Y300 at mythLevel 2 compared with level 0.

**Acceptance:**
- historical worlds show at least 3 band-related imp≥2 events per century after Y200
- no runaway bands
- at mythLevel 2: 0–6 dragons alive, expansion pace within ±25% of Historical
- at most 3 ms per year

**Needs contracts:** core/bands.js shape, addBand/removeBand/bandsNear, BAND_KINDS meta | kernel damageArmy + army.flags.hunt/merc semantics honoured by WP4 | hooks battle (kind band/beast), bandCreated/Destroyed/Raid, eruption, armyDisbanded | core/sites.js (lair, grave, pinned) | ext providers: routeValue, heroTarget, battle, opinion (common foe), rates (bandSpawn, horde, beastSpawn), yearRecord | mythLevel/mythOn gate + params banditry, monsterAbundance | registered mod key 'taming' (WP5) | published exports: WP4 breakRoute | render registries: registerLayer, registerFxType, hit kind 'band' | UI registries: registerView('band'), registerSearchSource, registerContextProvider, registerDirectorSource | tools contract: entity target + preview | RESOURCES dragonbone

## WP3 Peoples, Rulers & Cities (civ integration + divine acts)

**Owns:** src/sim/civ/** (all existing files: index.js, settlement.js, tech.js, expansion.js, land.js, rulers.js, government.js, culture.js, stability.js, state.js, civmonth.js, buildings.js, data.js, peoples.js, prose.js, territory.js, milestones.js, tools.js), src/sim/civ/dynasty.js (new), src/sim/civ/acts.js (new), src/sim/civ/previews.js (new), src/sim/civ/style.js (new)

**Proposals:** stats:surface-the-record (civ fixes), stats:lives-and-lineages (sim side), events:figure-lives (generals ageing part), events:news-value-annals (civ call sites), tactile:inspector-divine-acts (civ acts), ux:tool-preview-and-pair-tools (civ tools), tactile:tool-target-preview (civ part), tactile:intervention-fx-kit (civ emitters), visual:culture-architecture (civ.style), visual:wonders-on-map (wonder geometry), mythic:races (call sites), mythic:race-identity (call sites), mythic:arcane-schools (tech branch support), events:dynastic-politics (should), events:estates-factions (should: theocracy-trap quick fix only)

**1. Adopt the contracts.**
- computeMods applies, in order: techs, government, ruler, ages, wonders; then civ.effects via effectsOf (applyFx semantics); then each ext 'mods' provider. Clamp with LIMITS merged with registerModKeys. MODS_VERSION must fold in extVersion() and civ.effectsV.
- Settlement phases read core settlementMods(world, s): happiness, unrest, loyalty, health, defense, foodYield, production, culture, birth, mortality, attract (urbanDrift), housing and research.
- Read the WP5-registered keys with defaults:
  - forestFarm: farm conversion clears veg × (1−forestFarm); the forest farm cap × (0.6+0.4·forestFarm)
  - deepHalls: housing ×1.4 on hills and mountains
  - mortality: multiplies deaths
- Extension call sites:
  - genesis: for tribe k, firstOf('people') picks the race first, then the site is chosen by habit × mulOf('habitat', race, i)
  - findSite, findOverseasSite and emergence: mulOf('habitat') and sumOf('siteBonus'); splits inherit the parent's race
  - settleName when founding
  - demography in demographyPhase
  - lifespan for ruler and figure ageing
  - people.languageStyle passed to createLanguage(rng, style)
  - civTraits overrides from people
  - nameStyle in government styleName and ruler titles
  - archStyle
  - loyalty provider in socialPhase
  - heroTarget in the culture.js hero deeds; the default becomes a BEASTS_BY_BIOME list, so a desert no longer gets a marsh serpent
  - rates for 'emergence' and 'figureBirth'
- Merge registerTechs lazily by extVersion. Techs with branch 'arcane' are excluded from computeEra, grantEra and grantWorldKnowledge, and t.available is honoured. Merge registerBuildings and registerWonders, with race gating.

**2. Emit hooks:** famine (≥50 deaths or ≥5%), tierChanged, depositExhausted, buildingCompleted, wonderBuilt and wonderDestroyed, rulerDied, succession, techDiscovered (with first) and eraReached (with first; also write sys.civ.eraFirst[era] = {civId, day}), figureBorn and figureDied.

**3. Chronicle.**
- record() stops defaulting sid to the capital for civ-wide entries (keep x and y).
- Entries get key, ref and subject; successions carry key 'succession'.
- The Ruin message prints formatted numbers.

**4. Fixes.**
- military.strength is written monthly as the sum of the civ's army strength.
- figuresMonthly ages every figure in civ.flags.figs, including generals that WP4 promotes and pushes there.
- Living figures of a destroyed civ are marked dead on civDestroyed.
- archiveRuler keeps deeds, id, relation and predecessorId.
- New sys.civ.dynasties ledger (cap 400): {name, civId, start, end, rulers, founder, last, endCause}.

**5. Divine acts (acts.js), all logged by the kernel.** Each writes a divine chronicle entry with a ref and emits fx-kit types.
- Entity tools: bless_ruler, curse_ruler, smite_ruler (through the normal succession path), grant_heir, gift_tech (args.techId; the preview lists the available techs), commission_wonder (args.kind), rename (settlement, civ, religion or feature; 1–32 plain characters; bump versions; restyle the government name), depose.
- Pair tools: cede_town (settlement → civ) and send_settlers (settlement → tile, via an exported colonize).

**6. Previews (previews.js).**
- tribe and settle give the blocking reason and name the blocking town
- enlighten targets the civ outline
- prosper, unrest and ruin give estimate ranges
- previews never touch rng

**7. Fx-kit emitters.** prosper and enlighten emit bless; ruin emits curse plus a '−N' label; unrest emits curse; all carry src:'tool'.

**8. Architecture and wonders.**
- style.js: civ.style is set on civCreated from the language hash and origin biome, inherited from the parent with mutation, with race overrides from archStyle.
- At wonder completion, record geometry: great_wall path (up to 120 border tiles facing other civs within 12 tiles), grand_canal path (up to 60 tiles), great_dam i.

**9. Should items.**
- dynasty.js: ruler.spouse and heir; civ.claims decaying 2% a year; arrangeMarriage export and the pair tool 'arrange_marriage'; a personal-union branch in succession (claim ≥0.5 and claimant power ≥0.6×); regencies; exiles in sys.civ.exiles; restoration revolts (createCiv with the old name); providers casusBelli (restoration, claim) and allied (personal union).
- Theocracy-trap fix: rebelGovernment draws on the rebels' own conditions, and a theocracy can also exit through a legitimacy crisis or merchant pressure.

**Acceptance:**
- civ at most 38 ms per year
- Strength is non-zero for any civ with armies
- no general alive past age 90
- ruler history rows carry deeds
- SPEC §9 passes on 3 seeds
- providers absent or neutral leave level-0 histories unchanged

**Needs contracts:** core/effects.js (effectsOf, settlementMods, civ effect semantics) | core/ext.js providers: habitat, siteBonus, settleName, people, demography, lifespan, mods, loyalty, nameStyle, archStyle, heroTarget, rates, casusBelli, allied; registries registerModKeys/registerTechs/registerBuildings/registerWonders + extVersion | createCiv opts.race / createSettlement race; names.createLanguage(rng, style) | hooks to emit: famine, tierChanged, depositExhausted, buildingCompleted, wonderBuilt/Destroyed, rulerDied, succession, techDiscovered, eraReached, figureBorn/Died | chronicle key/ref/subject/fold; news filter folds 'succession' | tools contract: entity/pair targets, preview, polarity, logged applyEntityTool/applyPairTool | fx kit types bless/curse/label/founding with src:'tool' | data contract read by WP7: civ.style, world.wonders[].path/i | published exports this package provides: splitCiv, grantTech, discover, getMods, colonize, depose, arrangeMarriage (should)

## WP4 War, Faith, Trade & Nature (geo/nature/gen integration, previews, war ledger)

**Owns:** src/sim/geo/** (existing: war.js, diplomacy.js, trade.js, religion.js, disease.js, pathfinding.js, common.js), src/sim/geo/ledger.js (new), src/sim/geo/acts.js (new), src/sim/geo/previews.js (new), src/sim/nature/** (existing), src/sim/climate.js, src/sim/weather.js, src/sim/ecology.js, src/sim/disasters.js, src/gen/** (existing), src/gen/previews.js (new)

**Proposals:** stats:war-ledger-theatre (sim side), stats:surface-the-record (geo fixes), events:figure-lives (generals promoted on fame), stats:catastrophe-catalogue (emitters + storm tracks), ux:tool-preview-and-pair-tools (incite war, broker peace, forge alliance, open route; geo/nature/gen previews), tactile:tool-target-preview (geo/nature/gen part), tactile:intervention-fx-kit (emitters + bug fixes), events:news-value-annals (battle/pact call sites), stats:army-service-records (should, sim side), tactile:direct-manipulation (should: forecastTrack, steer_storm, command_army)

**1. Emit hooks with exact payloads.**
- battle (in war.js battle())
- siegeStarted and siegeEnded
- armyDisbanded
- plagueStarted, plagueEnded and plagueDeaths (monthly, per settlement)
- routeCreated and routeBroken
- religionFounded and schism
- quake, tsunami, eruption, impact, flood, locusts and fireEnded
- stormEnded: storms now keep a decimated st.track of up to 24 points plus landfalls, deaths and towns

All geo and nature chronicle writers get ref (war, plague, religion, volcano, storm, route, fire, figure) and key. Battles below the named/great threshold carry key 'battle.minor'; non-aggression and trade notes carry 'pact.nap' and 'pact.trade', so the news filter can fold them.

**2. War ledger (geo/ledger.js).**
- war.ledger = {b: [[day, x, y, winner, loser, dead, nameKey]] (cap 64; skirmishes merged per month), t: [[day, sid, from, to, code]] (from capture, raze and makePeace), armies: [summary up to 12]}
- geo.terms, endReason and goalSid are kept after the war ends
- old saves are rebuilt from geo.log

**3. Generals.**
- Leaders are plain {name, skill, born} on army.general.
- A leader is promoted to a figure (addFigure, and its id pushed into civ.flags.figs so WP3 ages it) only after a great victory or 3 or more wins; set army.flags.genId.
- Reuse filters to age under 70.
- All casualties go through kernel damageArmy with their source.

**4. Contract call sites.**
- battle and siege ext multipliers (capped)
- the opinion sum in targetOpinion
- allied() honoured in callToArms and the declaration skip
- the warAppetite multiplier
- casusBelli provider candidates merged into the war-name pools
- rates for prophet, schism, plagueEmergence, quake, volcano, meteor, storm and wildfire
- vegCap in ecology
- routeValue in trade
- settlementMods trade in tradeIncome, plagueDose in exposure, defense in sieges

Army rules:
- war plan, move and peace-disband skip army.flags.hunt
- flags.merc armies are normal soldiers
- civDestroyed cleanup leaves hunt armies to WP2

**5. Published exports.** breakRoute, routeValueOf, createPlague(world, sid, {lethalityMul, name, cause}), cureTown, foundReligion(world, s, {doctrine}), boostFervor, clearSiege, startWarNamed, addTreaty.

**6. Pair tools (acts.js), each with a preview (threads plus a feasibility reason).**
- incite_war (civ, civ): startWar with 'provocation' plus an opinion hit
- broker_peace: endWar as white peace with a truce
- forge_alliance
- open_route (settlement, settlement): findPath over land or sea

**7. Previews for every existing tool in geo, nature and gen.** Factor shared helpers so apply and preview call the same code; no rng and no mutation.
- discord and harmony: threads to the affected neighbours
- prophet and miracle: the target town and faith
- plague and cure
- quake: damage radius and towns
- volcano: 'Will wake Mount X' versus a new vent
- meteor: crater R, blast 2R, towns at risk
- tsunami: coasts in reach; flood; locusts; storm kind; rain and drought; wildfire
- bloom, forest, herds, predators and fish
- terrain brushes, including 'about N applications to break the surface' for Raise Island

**8. Fx kit.**
- Replace 'divine' with polarity types: curse for plague and discord, bless for cure and harmony, thread fx, terraform for terrain tools, sprout and spawn for ecology tools, raincall, parch and swirl for weather.
- Labels: magnitude, VEI, coasts struck.
- src:'tool' on every tool-triggered fx.
- Fixes: meteor prose clause order (meteors.js ~line 132); the island toast only when a tile actually crosses sea level; locust swarms exposed as world.sys.disasters.swarms [{id, x, y, r, vx, vy}] for drawing.

**9. Should items.**
- army.flags.l service counters (raised, peak, battles, won, dead, inflicted, attrition, sick, distance, captures), archived into war.ledger.armies
- storms.js forecastTrack(world, storm, days, push), pure, plus a hidden 'steer_storm' tool using st.push {vx, vy, days}
- 'command_army' entity tool (flags.divineGoal, goalUntil = day+180) honoured first by chooseTarget

**Acceptance:**
- geo at most 30 ms per year; nature budgets unchanged within ±1 ms
- the typical civ is at war 15–35% of the time
- previews never change rng.state (dev assert)
- headless hook counters are non-zero for every hook

**Needs contracts:** hooks catalogue + payloads (emitter side) | kernel damageArmy, army flags hunt/merc/genId/divineGoal | chronicle ref/key | core/ext.js call sites: battle, siege, opinion, allied, warAppetite, casusBelli, rates, vegCap, routeValue | core/effects.js settlementMods (trade, plagueDose, defense) | tools contract: pair/entity/hidden/preview/polarity + logging | fx kit types + src:'tool' | published exports this package provides (breakRoute, createPlague, cureTown, foundReligion, boostFervor, clearSiege, startWarNamed, addTreaty, forecastTrack)

## WP5 Mythic: races, magic & the Mythic switch

**Owns:** src/sim/myth/index.js (new; system {id:'myth', order:86}), src/sim/myth/races.js (new), src/sim/myth/identity.js (new), src/sim/myth/ley.js (new), src/sim/myth/mana.js (new), src/sim/myth/arcana.js (new), src/sim/myth/divine.js (new, should), src/sim/myth/fading.js (new, should), src/sim/myth/folklore.js (new, should), src/sim/myth/tools.js (new), src/sim/myth/prose.js (new), src/sim/myth/preview.js (new), src/render/myth.js (new: map modes + ley layer), src/ui/genesis.js (existing), src/ui/views/myth.js (new: registered sections), src/ui/legends.js (new tab, should), src/ui/css/myth.css (stub created by lead), tools/myth-check.mjs (new)

**Proposals:** mythic:myth-foundation, mythic:races, mythic:race-identity (data and providers), mythic:ley-mana, mythic:arcane-schools, mythic:myth-map-render, mythic:myth-tools (ley_line, wellspring, awaken_magic), ux:genesis-gallery (world-name field only), mythic:gods-answer (should), mythic:the-fading (should), mythic:race-relations (should), mythic:myth-ui-ledgers (should), mythic:legendary-level (should)

You own the Mythic mode as a whole: its gate, its peoples, its magic, its genesis UI and its visuals. Beasts live in WP2 under your gate.

**1. Foundation.**
- At level 0 the myth system returns before touching rng: no ensureField, no lists, every provider neutral (check mythOn inside each provider).
- Providers are registered at import.
- headless --determinism must pass.

**Genesis (genesis.js):**
- a Historical / Legendary / Mythic segmented switch above the presets
- a visibleIf filter for params
- mythic presets grouped by preset.mode
- a world-name field (param worldName)
- at level 2 the preview overlays ley lines and likely race homelands from mythPreview(world), about 5 ms at preview size
- Legendary stays disabled with a 'coming' note until folklore.js registers its deck

**2. Races (races.js).** Six races: human, elf, dwarf, orc, halfling, lizardfolk.
- An AFF Float32Array of biome × elevation-band affinities.
- Normalise the niches so each enabled race wins 5–30% of land by default; dwarves count hills.
- raceMix weights.
- Providers:
  - people: race pick at genesis with a penalty for repeats and at least 3 races when civCount ≥4; emergence picks the race the local land favours
  - habitat, demography (birth and mortality), lifespan (elves ×5, dwarves ×3, orcs ×0.7…), mods, civTraits
  - loyalty (should; race mismatch)
- nicheReport goes into report().

**3. Identity (identity.js).**
- Phonologies via people.languageStyle.
- nameStyle titles and styles, e.g. 'Under-King … of the Khazdun Holds', 'Sylvan Realm of …', '… Warband', 'the Shire of …', 'Brood of …'.
- archStyle per race.
- registerBuildings: tree-hall, moonwell, deep-hall, rune-forge, war-pit, beast-pen, smial, pantry, spawning pool, sun-altar.
- registerWonders: Heartwood Throne, Great Delving, Skull Throne, Hearth of Plenty, Serpent Ziggurat.
- Government biases via the mods and nameStyle providers.

**4. Ley and mana (ley.js, mana.js).**
- At init, when level ≥2, generate the ley network from forked rng ':ley': 18–24 nodes at plate boundaries, relief, old forest and volcanoes, joined by a minimum spanning tree plus about 25% extra short edges.
- Fields: f.ley (U8, full resolution); f.manaBase and f.mana (F32, half resolution). Relax monthly, at most 2.5 ms per year.
- Nodes are pinned sites of kind 'node' with names such as 'the Witchstone of …'.
- Monthly consumption by mage towers and arcane research.
- Export manaAt(x, y); keep civ.arcane.mana as a territory sample.
- Providers: vegCap ×(1+0.15·mana); casusBelli over coveted nodes ('The War of the Witchstone').

**5. Arcane schools (arcana.js).** Six schools registered with registerTechs (branch 'arcane', school, races, minMana; foreign schools cost ×1.5):
- Wizardry (human, open to any race)
- Sylvan Arts (elf)
- Runecraft (dwarf)
- Shamanism (orc)
- Hearth-craft (halfling)
- Serpent Rites (lizardfolk)
- plus Necromancy (dark)

Keys and providers:
- registerModKeys: arcana, wards, taming, luck, scrying, gates, necromancy, forestFarm, deepHalls, mortality (mul), each with limits.
- Research weighting via the tech def's available() and costs ÷ weave.
- battle ×(1+0.5·arcana·mana), capped at 1.6; siege ×(1+0.3·arcana).
- damage provider: ×(1−luck) for natural causes, ×(1−wards) for dragon, curse, rift and undead causes.

**6. render/myth.js.**
- registerMapMode for 'arcane' (violet mana ramp, drained patches in charcoal, glowing dashed ley lines, standing-stone nodes), 'peoples' (race hue families from RACE_META) and 'monsters' (wild-distance shading; WP2 draws arrows and lairs); all with when: mythLevel ≥2.
- A 'ground' layer with a faint ley glimmer in terrain mode at z ≥3.
- registerFxType for spell, leyflare and awaken.

**7. Tools (tools.js), group 'myth'.**
- ley_line: continuous drag; finish recomputes manaBase
- wellspring: creates a node
- awaken_magic: available below level 2; setParam mythLevel 2 with {force, log}, initialise ley and mana, bias emergence toward elder races for 50 years, imp-5 chronicle entry, emit mythAwakened

**8. UI (views/myth.js).** Register sections:
- civ: race badge and lifespan, school progress, territory mana
- settlement: race and minority note
- tile: mana, ley, nearest node
- site: node card

**9. Should items.**
- divine.js (gods answer): religion domain derived from doctrine; favour in sys.myth.favor[rid]; interventions on siege, famine, plague and raids through WP4 clearSiege and cureTown plus settlement effects; a 30-year cooldown per town; divineIntervention scaling
- fading.js: the weave scalar from co2, pollution and the industrial share; threshold chronicle entries; WP2 reads sys.myth.weave
- RACE_REL opinion provider and the 'ancient enmity' casus belli
- legends.js tab (key O): race population shares over time, weave and mana, a bestiary list from world.bands, and sites
- folklore.js: a Legendary deck in the core event registry with minMyth 1 (omens, saints and relic sites, witch-hunts, haunted ruins)

**10. Stats.** yearRecord provider {myth: {weave, mana, races: {race: pop}}}; report() covers race survival, niche shares and mana.

**Acceptance (tools/myth-check.mjs, 10 seeds):**
- level 0 is byte-identical with and without the myth module
- at level 2, every enabled race is alive at Y1000 in at least 60% of seeds
- era pacing within ±25% of Historical
- myth at most 8 ms per year at level 2

**Needs contracts:** params mythLevel/myth group/visibleIf/myth presets/worldName + mythLevel()/mythOn() accessors | constants CATEGORIES.myth, RACE_META, TOOL_GROUPS myth, RESOURCES starmetal | core/ext.js providers (people, habitat, demography, lifespan, mods, loyalty, nameStyle, archStyle, battle, siege, damage, vegCap, casusBelli, opinion, yearRecord) + registerModKeys/registerTechs/registerBuildings/registerWonders | core/sites.js (node, pinned) | core/events.js (folklore deck, should) | setParam force+log for awaken; hook mythAwakened | render registries: registerMapMode, registerLayer, registerFxType | UI registries: registerSection, registerTab, registerIcon, registerCommand | published exports used: WP4 clearSiege/cureTown/boostFervor, WP3 getMods | tools contract (myth group, available(world), continuous+finish) | headless --determinism

## WP6 Ledgers, Records & the Inspector

**Owns:** src/sim/stats.js (existing), src/sim/ledger.js (new), src/sim/records.js (new), src/sim/sites.js (new: hook-driven sites recorder), src/sim/catalogue.js (new), src/ui/inspector.js (existing; keep the lead's registry call sites), src/ui/chronicle.js (existing), src/ui/statistics.js (existing), src/ui/charts.js (existing), src/ui/nations.js (existing), src/ui/format.js (existing), src/ui/annals.js (new tab), src/ui/digest.js (new), src/ui/views/records.js (new views), src/ui/histomap.js (new, should), src/ui/compare.js (new, should), src/render/overlays.js (new layer), src/ui/css/records.css (stub created by lead)

**Proposals:** stats:surface-the-record (UI), stats:entity-ledgers, stats:chronicle-refs-almanac, stats:hall-of-records, stats:war-ledger-theatre (UI + overlay), stats:lives-and-lineages (views), stats:catastrophe-catalogue (recorder + almanac), visual:historic-sites (sim recorder), ux:century-digest + stats:annals-digest (merged), events:news-value-annals (UI: fold, Because, consequences), stats:demographics (should), stats:histomap (should), stats:compare-nations + ux:compare-nations (should), stats:chart-time-travel (should)

**1. Ledger (ledger.js, run from stats at order 100).**
- world.history.series = {s, c, r, w, a, p, b}. Each series uses doubling-step decimation at K = 48 samples per channel (pairs averaged, or the max for peak and toll channels).
- Channels and cadence:
  - settlements, yearly: pop, wealth, trade, health, happiness, unrest, defense, culture
  - civs, yearly: pop, territory, towns, treasury, stability, manpower, era, army strength, wars, prestige
  - religions, yearly
  - wars, monthly: score, casualties per side, occupied, armies
  - plagues, monthly
  - armies, every 10 days: strength, morale, supply, x, y
  - bands, monthly
- s.own owner chain from the settlementCreated, settlementTransferred and settlementDestroyed hooks.
- Retention rules: dead entities freeze; small dead towns drop their series after 100 years.
- Exports series() and ownerChain(); merge yearRecord providers into each yearly record.
- Fix the top-48 dropout in the civ sparkline.

**2. sites.js recorder.** Subscribes to hooks and calls core addSite:
- battle and siege, merged by name or within 1.5 tiles
- ruins on settlementDestroyed: permanent, with a snapshot of peak, maxTier, buildings, civId, originCivId, wonderIds and cause
- craters (impact), eruptions of VEI ≥5, quakes of M ≥7.5
- plague pits (towns that lost over 25%), wrecks (stormEnded sinkings, bandRaid sunk), treaty sites

catalogue.js keeps world.history.events (cap 500, deterministic eviction) with magnitudes and storm tracks.

**3. Records (records.js).**
- sys.stats.records: per key, the top 5 holders and up to 8 breaks.
- Updated from hooks (battle dead, quake magnitude, VEI, storm deaths, fire tiles, plague deaths, famine) and from a yearly O(entities) scan (largest city, peak empire, longest reign and dynasty, most-conquered city, eternal rivals, longest and deadliest war, richest road).
- Record-broken chronicle entries (imp 3) only after Y100, with a clear margin and at most one per key per 25 years; the template is picked by day % n, never rng.

**4. Inspector (inspector.js).** A surface-the-record pass over every view:
- plague: peak, towns and nations struck, worst hit, cause, strains, 'R ≈ 2.8' instead of 280%
- religion: peak and peakDay, deity, doctrine, schisms, prophet link
- volcano: kind, setting, eruptions, last VEI
- storm: category, landfalls, deaths, towns
- war: battle table, terms, endReason, goal, changed hands, rivalry line, a TimeChart of score with battle ticks, casualty bars, and a theatre plate via ui/plate.js
- civ: allies and vassals as links, conquests, a knowledge timeline, the People section (should)
- settlement: a humanised Story (raw flags only behind a dev pref), city-character header (epithet, specialties, legend), owner chain

Every view gets a MiniChart from the ledger series. Register new views: route, figure, ruler, dynasty, wonder, fire, site, and a basic continent view. Keep the lead's registerSection and title-action call sites working.

**5. Chronicle (chronicle.js).**
- histories filter by ref, with a text fallback for old saves
- fold entries hidden from the Notable view
- 'Because' link and Consequences list
- handle 'chronicleScrollTo'
- a year-range chip

**6. Annals tab (annals.js, key R).**
- Almanac with search, sort and live/ended filters over: wars, plagues, faiths, eruptions, quakes, storms, fires, figures, wonders, routes, dynasties, fallen nations, ruins and other sites, and bands
- Hall of Records cards
- Histomap (should)

**7. Digest (digest.js).**
- Pure digest(world, fromDay, toDay): population change, top risers and fallers, founded, split and fallen nations, the deadliest war and biggest conquests, faiths, plague deaths, catastrophes, era firsts, records broken, and atlas plates before and after.
- Shown on 'leapDone', on run-until arrival and on 'worldRestored' when the span is over 20 years; also as an on-demand command.

**8. render/overlays.js.** A layer drawn for the selected entity:
- war: battle swords sized by log(dead) in the winner's colour, rings on captured towns, an X on razed towns
- army: its track from the series
- storm: its track, live or archived
- plague: the front
- faith: its reach

Use rendererSel from the registered views.

**9. Statistics.**
- World Ledger tiles from the sys counters
- new charts from fields already recorded: toll of the years, pulse of history by category, trade and wealth, scars, drought and aerosol
- the largest-city tile is linked
- should: chart marks, click to jump in time and range zoom; demographics; compare (also reachable from the nations ledger)

**Acceptance:**
- stats at most 7 ms per year
- save at most +2 MB at Y1000 on a medium map
- every chronicle ref opens a view
- Inspector refresh under 3 ms at 4 Hz

**Needs contracts:** hooks (all notable-event payloads) + settlement lifecycle hooks | core/sites.js addSite/merge/eviction + SITE_KINDS | chronicle ref/key/cause/fold + REF_KINDS | ext yearRecord provider merge | UI registries: registerView/registerSection/registerTitleAction (keep call sites), registerTab, registerCommand, registerSearchSource | app events leapDone/worldRestored/chronicleScrollTo/timeTravel | src/ui/plate.js drawAtlasPlate | render registerLayer + rendererSel kinds | data written by others: war.ledger (WP4), sys.civ.dynasties/eraFirst + ruler deeds (WP3), s.traits/epithet/legend (WP1), sys.bands.archive (WP2) | published exports this package provides: series, ownerChain, getRecords, digest

## WP7 Close-zoom depth & feedback rendering

**Owns:** src/render/renderer.js (existing; keep the lead's layer, mode and fx registry call sites), src/render/camera.js, src/render/detail.js, src/render/terrain.js, src/render/vectors.js, src/render/glyphs.js, src/render/labels.js, src/render/entities.js, src/render/fx.js, src/render/territory.js, src/render/modes.js, src/render/palette.js, src/render/clouds.js, src/render/dev.html, src/render/lod.js (new), src/render/cityplan.js (new), src/render/sites.js (new), src/render/highlights.js (new), src/render/armies.js (new, should), src/render/fields.js (new, should), src/render/traffic.js (new, should), tools/zoom-perf.mjs (new)

**Proposals:** visual:lod-chunk-cache, visual:zoom-ladder-ux (render side), visual:city-ground-plans, visual:wonders-on-map, visual:historic-sites (render), visual:culture-architecture (+ race glyphs), tactile:intervention-fx-kit (fx types), tactile:tool-target-preview + ux:tool-preview-and-pair-tools (highlights), ux:map-affordance-polish (render fixes), visual:traffic-by-era (wake fix must; rest should), visual:river-water-detail (knob fix must; ribbons should), visual:field-systems (should), visual:armies-formations (should)

**1. LOD chunk pyramid (lod.js).**
- Levels P = 16·2^k px per tile (k = 0..4); chunks of 256 device px; key family|k|cx|cy.
- Per-chunk FNV signatures over quantised biome, farm, veg, snow, popDensity, road, burnScar, devastation, fire and river with a 1-tile apron, plus a season bucket (coarsened when fx.dps > 60). Re-sign visible chunks every 300 ms.
- Build queue nearest-first, within a 3 ms per frame budget (at most 2 builds a frame; 1 a frame at Max speed).
- On a miss, fall back to the parent level and then the base raster; new chunks fade in over 120 ms.
- LRU cap 48 MB desktop, 24 MB phone.
- An exported registerPainter(id, minLevel, paint) so wave-2 painters (enchant, blight, scars, roads) can plug in.
- detail.js becomes a chunk painter with P-scaled sizes.
- glyphs.js quantises sprite sizes per level, with one SpriteCache per level (fixes the churn from 310 to 1,380 sprites).
- terrain.js exports paintGround (the raster upscaled plus a relief/grain pattern), so zoom past z26 is no longer blurry.

**2. Zoom ladder.**
- LOD_BANDS: World, Continent, Region, Province, Town, Street.
- getZoomInfo().
- Smoothstep crossfades for farm plots, hill strokes and the town icon symbol-to-picture switch.
- maxZoom 320 once lodReady is true.
- frameBox() for framing a bounding box.

**3. City plans (cityplan.js), at z ≥24.**
- buildPlan(world, s) gives footprint, arterials along the town's real road and river directions, ring roads, and growth-ordered blocks: built up to blocksFor(peakPopulation), lived in up to blocksFor(population); the difference shows as roofless, overgrown blocks.
- Walls by level, with gates.
- Landmarks by building key and level: palace, temple roof in the faith colour, market, library, harbour piers with moored ships, aqueduct, mine headframe, factory with downwind smoke, station, airport.
- s.project scaffolding; siege ring with breaches.
- Style from civ.style of s.originCivId, race from RACE_META; the radius is clamped to 0.45 × the nearest-neighbour distance.
- Plan LRU of 64; landmark hits with kind 'landmark'.
- Ruin foundations for sites of kind 'ruin', from the ruin's data snapshot.

**4. Wonders.**
- A glyph registry for all 22 kinds: a gold-ringed symbol at z 6–16, a silhouette at z 16–64, and part of the city plan at z ≥64.
- great_wall, grand_canal and great_dam drawn from wonder.path and wonder.i.
- Rubble with 'ruins of …' labels; hits with kind 'wonder'.

**5. Sites (sites.js).**
- Symbols by SITE_KINDS minZoom, sized by log(dead).
- Graves and cairns baked into chunks (count = min(40, dead/250)).
- Labels such as 'Crossing of X — 4 battles, 10,500 dead'; hits with kind 'site'.
- Ruins come from sites; remove the 60-year and peak ≥500 ruin filter.

**6. Architecture.**
- settlementSprite keyed by civ.style and race, with about 6 roof × 5 temple variants.
- Race glyphs: dwarf rock gate, elf great tree, orc spiked palisade, halfling mounds, lizardfolk stilts and ziggurat.
- Race symbols at small zoom.

**7. Fx kit (fx.js).**
- Types: bless, curse, terraform, sprout, spawn, raincall, parch, thread, label (cap 24, stacked), swirl, rewind, riot, fair.
- Particle kinds LEAF, RAIN and FEATHER; pool stays at 900.
- A vignette whose tint follows the act's polarity.
- src:'tool' effects are exempt from dps scaling and get priority 10.
- Off-screen chevron pointers with hits 'fxPointer'.
- Consume registerFxType; draw locust swarms (hits 'swarm').

**8. highlights.js and renderer API.**
- setToolPreview: rotating reticles, civ outline tinted by tone, damage rings, threads, an invalid flag.
- setHighlights, pickAll, recentFx, the onFx callback.
- rendererSel kinds {kind:'civs', ids} and {kind:'box'}.
- Hits for volcanoes and caravans.

**9. Polish fixes.**
- army flag labels as integers or k
- ship wakes built from the caravan's own path
- rivers drawn with lineCap butt and a single alpha per bucket (removes the knobs)

**10. Should items.** Field systems, armies as formations, river ribbons with deltas and surf, traffic by era.

**Acceptance (tools/zoom-perf.mjs, headless Chrome with GPU flush):**
- zoom sweep z10→80: median ≤12 ms, p90 ≤20 ms
- panning at z20: detail ≤8 ms
- the sprite cache is stable on a second sweep
- no visible magnification blur at z80
- 50 fps at 1440×900

**Needs contracts:** render registries (registerLayer slots, registerFxType, registerMapMode) — keep call sites | renderer API additions list (setToolPreview, setHighlights, pickAll, recentFx, onFx, getZoomInfo, frameBox, lodReady, rendererSel kinds) | fx kit type list + emitFx fields | data contracts: civ.style, civ.race/s.race + RACE_META, s.traits/epithet, world.wonders[].path/i, world.sites + SITE_KINDS, s.project/siege/buildings | tool preview result shape | hit kinds list

## WP8 Story, navigation & hands (UI)

**Owns:** src/main.js (after lead wiring), src/ui/app.js, src/ui/input.js, src/ui/hud.js, src/ui/toasts.js, src/ui/panel.js, src/ui/mapdock.js, src/ui/prefs.js, src/ui/widgets.js, src/ui/palette.js, src/ui/worldtab.js, src/ui/atlas.js, src/ui/saves.js, src/ui/dom.js, src/ui/icons.js, src/ui/theme.js, src/ui/fallback-renderer.js, styles.css, src/ui/director.js (new), src/ui/until.js (new), src/ui/command.js (new), src/ui/contextmenu.js (new), src/ui/watch.js (new), src/ui/chrono.js (new), src/ui/acts.js (new), src/ui/deedcard.js (new), src/ui/timeline.js (new, should), src/ui/audio.js (new, should), src/render/pins.js (new, should), src/ui/css/story.css (stub created by lead)

**Proposals:** ux:director-story-mode + tactile:director-mode, ux:run-until-and-alert-rules, ux:command-palette-search, ux:map-context-menu, ux:watchlist-pins-follow + tactile:patron-nation, ux:chronoscope-rewind-undo-branch + tactile:undo-rewind (UI), ux:tool-preview-and-pair-tools + tactile:tool-target-preview (UI flows), tactile:inspector-divine-acts (UI), ux:map-affordance-polish (UI), visual:zoom-ladder-ux (scale bar, zoom badge, dive-in), tactile:tool-flow-ergonomics (merged deed card; wheel modifiers should), ux:history-timeline-bar (should), ux:event-pins-overlay (should), tactile:webaudio-soundscape (should), ux:resume-and-share (should: autosave resume card)

**1. Director (director.js).** Key G and a Story button on the time drive.
- Candidates:
  - chronicle entries of imp ≥3 that have a place and no fold
  - live scans: sieges, erupting volcanoes, storms within 3 tiles of land, fires over 40 tiles, plague fronts
  - renderer.recentFx
  - registered director sources
- score = base[type] × (1 + imp²/5) × novelty × freshness; switch only when best > current × 1.5 or the dwell time is used up.
- Framing with frameBox and focusOn. A lower-third caption with typewriter text and Inspect / Follow / Skip.
- Pacing: slow to Fast on action shots, skip quiet years at Rapid with a chip; restore the user's speed when the Director turns off.
- Suspend for 20 s on 'userCamera'; cut instead of flying under reduced motion.
- A toast filter suppresses the imp-3 slips the Director captions.
- Offered by default on a first world and on phones.

**2. Run until (until.js).**
- The Leap modal gains an 'Until…' section; U opens it and Shift+U repeats the last condition.
- Built-in conditions:
  - next war (any, selected or watched nation)
  - next historic or epochal event
  - a nation falls, or a new one rises
  - next plague outbreak
  - next eruption, meteor or great disaster
  - someone reaches a new era
  - the selected town changes hands, is besieged, or reaches its next tier
  - the selected ruler dies
  - Year N
- Conditions use read-only hook listeners (flags only) or chronicleSince, passed through app.fastForward's until option, with a 1,000-year cap.
- On a hit: an Arrived card with 'Keep going until the next one'.
- A Notices popover replaces the auto-pause switch: per-category toast threshold, pause rules, quiet at Rapid, and clearing the Chronicle badge after leaps.

**3. Command palette (command.js).** '/' and Ctrl/Cmd+K.
- A lazily built, fuzzy, diacritic- and apostrophe-insensitive index over civs (live and fallen), settlements and ruins, wars, faiths, plagues, figures, wonders, features, volcanoes, storms, bands, sites, map modes, tools, registered commands and search sources.
- Chronicle full-text search with '#'; prefixes '>' commands and '@' places.
- Enter flies there; Alt+Enter opens the record without moving; Shift+Enter watches.
- Recents keyed by seed; a full-height sheet on phones.

**4. Context menu (contextmenu.js), on 'mapContext'.**
- Opens on right-click without a drag, or a 550 ms long-press in Inspect.
- Header names what lies under the cursor: biome, height, owner.
- Lists every stacked entity from pickAll.
- Actions: inspect each, nation, follow, watch, pin view, zoom here, run until for this place or nation, use last tool here, show in the Atlas, copy view link; plus items from registered providers.

**5. Watch and follow (watch.js).**
- world.ui.watch: up to 8 chips with live values and a red dot on news.
- Watched entries become gilded toasts that bypass the meter (via a toast filter).
- Edge arrows for watched movers off screen.
- Pins: B saves a view; Shift+Digit1–9 jumps to it.
- Patron people: an HUD chip, a saga filter, and an elegy plus successor choice when it falls.
- Follow-anything uses each view's frame(), refitted every 2 s. Follow survives selection changes and is cleared by 'userCamera'. Z frames the selection.

**6. Chronoscope (chrono.js).**
- Keyframe ring: every 10 sim-years for the last century, every 50 before that, and before every tool stroke and logged parameter change.
- Memory budget 64 MB desktop, 24 MB phone; older frames compressed asynchronously with CompressionStream.
- Undo and redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z) for the last 10 interventions: restoreKeyframe from the nearest frame at or before the intervention, then replayTo with that intervention skipped, showing a progress card when replaying more than a year; then app.restoreWorld.
- 'Rewind to here' from the Atlas, the palette and the timeline, with [Keep as branch] [Discard] [Cancel].
- Branch slots in saves.js (branchOf, branchDay, thumbnail).
- Rewind fx and a 'The hand was stayed' toast.

**7. Hands (input.js, palette.js, acts.js, deedcard.js).**
- Hover calls previewTool every 120 ms, feeding renderer.setToolPreview, the hover-card text or reason, and an invalid cursor.
- Dangerous catastrophes need a second click unless undo is available.
- Pair-tool flow: pick the source, a rubber band follows the cursor, pick the target; Esc cancels.
- Entity tools appear as auto-generated 'Divine acts' sections registered for every kind in a tool's entity.kinds, with pickers for techs and wonders and a rename input.
- Fate cards come from preview.cards.
- palette uses availableTools and skips hidden tools.
- deedcard.js merges a tool's status message and its divine chronicle entry (within 1.5 s) into one card with Undo / Inspect / Watch.

**8. Polish.**
- Double-click zooms ×2 and still opens the nation; Tab cycles visible towns.
- A scale bar and zoom-level badge (from getZoomInfo) in mapdock.
- The tooltip closes with its popover.
- The war-score caption follows the sign.
- Help rows come from the key registry; the badge resets on 'leapDone'.

**9. Should items.**
- timeline.js (Y): five lanes; viewing the past pauses time
- render/pins.js: event pins with clustering; clicking one triggers chronicleScrollTo
- audio.js: synthesised voices via renderer.onFx and toolApplied, off by default
- autosave resume card and slot thumbnails
- Shift and Alt wheel modifiers for brush radius and strength
- storm and army grab gestures (using the WP4 should tools)

**Acceptance:**
- headless --rewind-test passes
- an undo after 5 sim-years restores in under 2 s on a medium map
- the palette opens in under 50 ms
- there are no key conflicts with the reserved table
- the 390×844 phone layout has no horizontal scroll

**Needs contracts:** UI registries (all) + mounts.js + reserved key table | app API: follow {kind,id}, fastForward(..., {until}), restoreWorld, events userCamera/mapContext/mapDblClick/leapDone/worldRestored/toolApplied/chronicleScrollTo/timeTravel/atlasGoto | core/keyframe.js + core/replay.js + interventions log + worldChecksum | tools contract: availableTools, previewTool, applyPairTool, applyEntityTool, preview result shape incl. cards, danger, hidden, polarity | world.ui shape (watch, pins, patron, lineage) | renderer API: setToolPreview, pickAll, recentFx, onFx, getZoomInfo, frameBox, setHighlights | chronicle fold field (skip in toasts/director) | hooks for until conditions (read-only listeners, world.cache.replaying guard) | src/ui/plate.js
