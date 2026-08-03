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

## Texture atlases

All surfaces come from four AI-generated, grid-labeled 3×3 texture atlases (`public/textures/`), sliced at runtime into material cards (id, roughness, metalness, real-world size).

## Controls

| Key | Action |
|---|---|
| WASD / Shift | Move / sprint |
| Click | Fire (foot) · hydraulic punch (mech) |
| E | Board vehicle (driver seat) / pilot mech / exit |
| Q | Switch vehicle seat |
| B, 1–6, R | Build mode, piece select, rotate 90° |
| M | Mech Bay |
| L | Game ↔ inspection layer |

## Develop

```bash
npm install
npm run dev    # local dev server
npm run build  # production build → dist/
```

Deployment to GitHub Pages runs via `.github/workflows/pages.yml` on every push to `main`.
