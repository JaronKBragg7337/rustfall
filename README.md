# RUSTFALL — Wasteland Engine

A deterministic post-apocalyptic wasteland survival vertical slice, built with **Three.js + React + TypeScript + Vite**.

**▶ Play it:** https://jaronkbragg7337.github.io/rustfall/

## The world

- **Open wasteland** — 200×200 m of cracked highways, ruined blocks, container yards, biome fields (scorch, rust dunes, rubble, mud)
- **Roaming robots** — helpful **worker robots** run a salvage loop that fills your scrap stockpile; **hostile robots** patrol, hunt, and fire zap bolts
- **Shamblers** — dead creatures that converge on the living
- **Community NPCs** — a Farmer, a Scrapper, and a Guard working job stations around a walled home base
- **Boss** — the 9-meter **IRON WARDEN** stomping the scorch arena
- **Vehicles with real seats** — Dune Buggy (2 seats) and Flatbed Truck (4 seats); only the driver steers, anyone can ride (**Q** to switch seats)
- **Modular mech suit** — pilot it, then swap torso / arms / legs in the Mech Bay; every swap re-textures the part and re-solves speed / armor / power
- **Real buildings** — the two-storey Homestead has three ground-floor rooms, walk-through doorways, windows, climbable stairs, and an upper level
- **Connector-snapped construction** — build mode ghosts snap to the 4 m module grid *and* to neighboring pieces, with a visible snap effect; stack floors on walls, place doorway walls and stairs

## ◈ Dual world layer

Press **L** (or **⚙ Settings → World Layer**) to flip between the game and the **inspection layer**: module grid, grid addresses (`L0-H{col}-R{row}`), per-asset IDs, bounding volumes, and a live validation report (floating / buried / intersecting checks).

## Terrain

The ground is a deterministic fBm heightfield with a four-way splat blend (dirt,
scorch, rust sand, dry mud) and graded flat pads under every structure — the same
cut-and-fill a real site gets before anything is built. `terrain.heightAt()` is the
single source of truth: the mesh, the player's feet, entity grounding and prop
placement all sample it.

## Surfaces

Materials project from position along the dominant normal axis rather than using
mesh UVs, so **texel density is uniform across every face by construction** — a 4 m
wall face and its 0.2 m return edge resolve identically. The same shader pass adds
anti-tiling (a second sample at an incommensurate scale), ground-accumulated grime,
settled dust on up-faces, and roughness variation for edge wear.

Source atlases are four grid-labeled 3×3 sheets in `public/textures/`, sliced at
runtime into material cards (id, roughness, metalness, real-world size). The game
loads 1536px WebP (~2.4 MB total); the 2048px PNG masters are kept alongside them.

## Assembly

Assets are built primary form → secondary components → tertiary detail. Exposed
edges are broken (a perfectly sharp 90° edge is a rendering artifact, not an object),
trim is separate geometry so it casts its own shadow lines, and bolts, rivets, welds
and seams go through `InstancedMesh`. See `kit.ts` for the vocabulary. Dimensions are
real: containers are 6.06 × 2.44 × 2.59 m, doors 1.0 × 2.1 m, stair risers 0.2 m.

## Controls

| Key | Action |
|---|---|
| WASD / Shift | Move / sprint |
| Space / Ctrl | Jump / crouch |
| Click | Fire (foot) · hydraulic punch (mech) |
| E | Board vehicle (driver seat) / pilot mech / exit |
| Q | Switch vehicle seat |
| B, 1–6, R | Build mode, piece select, rotate 90° |
| V | First person ↔ third person |
| M | Mech Bay |
| L | Game ↔ inspection layer |
| P / Esc | Start / stop the showcase tour |
| G | Dev mode (invulnerable) |

## Time, weather and sound

The sun moves through a real arc — sky gradient, fog, light colour, shadow
direction and exposure are all derived from one number, so a full day/night
cycle costs almost nothing beyond moving it. Night settles at a readable
moonlight rather than true darkness, with a starfield overhead. Dust storms roll
through on their own timer, collapsing draw distance, muting the sun and filling
the air with drifting grit. **⚙ Settings → TIME** lets you scrub, jump to
dawn/noon/dusk/night, freeze the clock, or summon a storm.

All audio is synthesised at runtime from oscillators and filtered noise — no
sample library, no download. Footsteps change timbre by surface, and the wind
bed tracks the weather.

## Showcase tour

**⚙ Settings → ▶ SHOWCASE TOUR** (or **P**) hands the camera to an automatic tour:
an authored shot list that orbits each landmark while the world layer flips between
the game view and the inspection view on its own timer, so the same place is shown
twice — once as the wasteland, once as the structure underneath. The world keeps
running while it plays. Skip a shot or exit from the on-screen controls.

**On a phone or tablet:** drag the left half of the screen to move (push past the
ring to sprint), drag the right half to look, and use the thumb-arc buttons for
fire, jump, interact and build. Contextual buttons (rotate, seat, mech bay) appear
only when they apply. The HUD scales down so it never covers the play area.

## Develop

```bash
npm install
npm run dev    # local dev server
npm run build  # production build → dist/
```

Deployment to GitHub Pages runs via `.github/workflows/pages.yml` on every push to `main`.
