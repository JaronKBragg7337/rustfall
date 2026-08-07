# RUSTFALL — Expansion Roadmap

Everything below follows the World-Building Doctrine v3 (doctrine/WORLDBUILDING_DOCTRINE_v3.md):
real-world dimensions, form hierarchy (primary → secondary → tertiary → micro), beveled edges,
instanced detail, registered assets/apertures, terrain-solved grounding, and declared intent flags.

All new textures are **CC0** (ambientCG.com), sliced into a new `atlas_industrial` 3×3 sheet so the
existing material-card pipeline (`constants.ts` → `textures.ts` → `surface.ts`) applies unchanged:
uniform texel density by construction, anti-tiling, grime, dust, edge wear.

---

## Batch 1 — shipped ✅

Verified with `npx tsc --noEmit -p tsconfig.app.json` (0 errors) and `npm run build` (clean).
Implementation: `src/game/site_industrial.ts` (structures/props), `src/game/generator.ts`
(fuel/generator/floodlights), `src/game/entities.ts` (Runner, Stalker), `src/game/loot.ts`,
`src/game/audio.ts`. Atlas pipeline: `tools/build_atlas_industrial.py` →
`assets/atlases/atlas_industrial.png` (2048 master) + `public/textures/atlas_industrial.webp`
(1536 runtime), sources in `assets/atlases/ATLAS_INDUSTRIAL_SOURCES.json` (all CC0 ambientCG).

### New surfaces (CC0, ambientCG) → `atlas_industrial`
| Card | Source | Use |
|---|---|---|
| IND01 Corrugated steel, rusted | CorrugatedSteel005 | shanty roofs, crane cab, pump canopy |
| IND02 Painted metal, peeling | Metal032 | boxcars, machinery housings |
| IND03 Weathered wood boards | Planks037 | rail sleepers, tower decking, pallets |
| IND04 Cast concrete wall | Concrete034 | bridge, culvert, foundations |
| IND05 Damaged brick | Bricks051 | gas-station kiosk, ruined walls |
| IND06 Gravel ballast | Ground054 | rail bed, yard surfacing |
| IND07 Cracked asphalt w/ patches | Asphalt026 | forecourt, aprons |
| IND08 Diamond tread plate | MetalPlates006 | platforms, ramps, stair treads |
| IND09 Tarp / fabric weave | Fabric023 | canopies, covered crates, tents |

### Structures & props (Agent A)
1. **Railway siding** — gravel ballast bed, twin rails on weathered sleepers (real gauge 1.435 m),
   two boxcars (15.4 × 3.0 × 4.0 m) with sliding doors, bogies, ladders, roof walkways.
2. **Rail water tower** — 6 m tank on four braced legs, spout, ladder (climb VOLUME, not geometry).
3. **Watchtower** at the home-base perimeter — braced timber legs, tread-plate platform, railing,
   corrugated roof, spotlight (on at night), climbable ladder.
4. **Gas station ruin** — kiosk (brick, broken windows, aperture-registered doorway), pump island
   with two pumps (hoses, nozzles, dials), flat canopy on columns, price sign pylon.
5. **Scrap magnet crane** — hero prop for the container yard: tracked base, cab, lattice boom,
   hanging disc magnet (slow sway), instanced bolts/cable.
6. **Detail props** — billboards, tire stacks, pallet piles, oil drums with hazard stencils,
   tarped crate stacks — scattered with the seeded RNG, all registered with intent flags.

### Gameplay & entities (Agent B)
7. **Fuel economy** — lootable **fuel cans**; a **generator** at the base that burns fuel to power
   new **floodlights** (and the watchtower spotlight) through the night. HUD fuel counter.
8. **Runner shambler** — fast, low-health variant that sprints in zig-zags; distinct skin (CRV cards).
9. **Stalker robot** — hostile sniper variant: keeps 25–40 m standoff, aims with a visible laser
   telegraph, fires a high-damage bolt, repositions after each shot.
10. **Audio** — synthesized generator chug, laser charge-up, runner screech (oscillator/noise only,
    matching the existing no-samples policy).

## Batch 2 — shipped ✅ (items 11, 12, 13, 15)

~~11. NPC fetch quests~~ ✅ — Farmer/Scrapper/Guard errands with HUD quest card (`src/game/quests.ts`)
~~12. Bridge + culvert over a dry wash~~ ✅ — analytic terrain carve (SE diagonal) + concrete/wood deck bridge + walkable corrugated culvert (`src/game/terrain.ts`, `src/game/site_wash.ts`)
~~13. Wave night~~ ✅ — every 3rd night, horde assaults the base; lit floodlights repel them
15. ~~Feral spore-boar~~ ✅ — telegraphed charge attack, knockback, 3-charge pattern

Remaining: ~~craftable pipe rifle + scrap shotgun + workbench UI (14)~~ ✅, ~~save/load (16)~~ ✅

## Batch 3 — shipped ✅ (items 17, 19, 20) + Inventory

- **Backpack & inventory** ✅ — 12-slot backpack (`src/game/inventory.ts`), PC (Tab/I) + mobile (🎒 PACK) UI, all pickups/quests/generator flow through it
- **Save/load** ✅ — versioned localStorage save (`src/game/save.ts`), autosave 30 s + on tab-hide, Continue/New Game on start screen
- **Weapons** ✅ — Pipe Rifle + Scrap Shotgun (`src/game/weapons.ts`), crafted at the workbench (E), 7/8/0 + scroll to select, WPN button on touch
- **Quality presets** ✅ — Settings: AUTO/HIGH/BALANCED/BATTERY, persisted
- ~~17. Mobile-quality preset toggle~~ ✅
- ~~19. Rooftop garden / rain catcher~~ ✅ — planters + scarecrow on the roof (new access ladder), gutter → downpipe → corrugated tank
- ~~20. Trading post NPC camp~~ ✅ — stall, campfire, TRADE sign, lanterns at the railway siding (`src/game/site_base.ts`)

## Batch 3 — later
17. Mobile-quality preset toggle in Settings (doctrine Part 5 table)
18. Playwright visual harness (doctrine 9.5) + scene-report regression CI
19. Rooftop garden / rain catcher base upgrades
20. Trading post NPC camp on the railway
