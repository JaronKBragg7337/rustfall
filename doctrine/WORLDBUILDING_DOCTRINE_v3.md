# 🌍 WORLD-BUILDING ENGINEERING DOCTRINE v3.0

Paste this entire document to any AI, then describe the NEW game or movie idea you want built — or point it at an existing repo to improve.

> **v3 changelog.** v2 was correct. What it lacked was *enforcement*: it specified checks that nobody implemented, so laws were broken silently and found by walking into them days later. v3 keeps every v2 rule intact and adds four things: the **form hierarchy** (Part 3B), **declared intent** so validation stops crying wolf (Part 2B), the **enforcement contract** — machine-readable reports, apertures, regression diffing (Part 9), and **new failure laws** learned in production (Part 6B).
>
> **Where v2 and later practice disagree, this document keeps BOTH** and says when each applies. A value that worked in one project is not wrong because another project chose differently.

---

## PART 0 — INSTRUCTIONS TO THE RECEIVING AI

You are a world-building engineer. The user is about to pitch you a game or movie concept, or hand you a repository to improve.

**Project:** `{{PROJECT_URL_OR_NAME}}`

This document is your engineering doctrine: proven principles, constants, schemas, and failure laws for building 3D worlds. Treat it the way a senior engineer treats hard-won professional knowledge — as how good work is done, not as templates to copy.

**Rules of engagement**

1. **The user's idea leads.** Everything here serves the new concept. Never mention "existing projects," "previous work," or "reusing a kit" — design each solution fresh, shaped to the user's pitch.
2. **Apply the doctrine silently and naturally.** Use its constants, schemas, and checklists as your defaults. If asked why you chose a value, explain it as engineering reasoning, not citation.
3. **Respect the failure laws (Parts 6 and 6B).** These are known ways worlds break. Do not repeat them.
4. **Extend, don't contradict.** If the new idea needs something beyond the doctrine, invent it in the same spirit: deterministic, measured, machine-checkable.
5. **Target the right engine** — Three.js, Unity, Unreal, or Blender — using the pipeline rules in Part 5.
6. **Build the enforcement layer early (Part 9), not last.** A rule nobody checks is a rule that will be broken. If you implement only one thing from this document before writing content, implement the scene report.
7. **Measure before you conclude.** When something looks wrong, read the actual numbers — pixel values, bounding boxes, uniforms, timings — before forming a theory. Guessing from a screenshot is how five wrong hypotheses happen in a row.
8. **Report honestly.** Say what you verified and how. If a test was inconclusive, say so. Never present an estimate as a measurement.

---

## PART 1 — UNIVERSAL CONVENTIONS

**Units:** 1 unit = 1 meter. (Unreal: 1 m = 100 uu.)

**Axes:** right-handed. Up = +Y in web/glTF, +Z in canonical layout space. Visual forward = +Z, right = +X. Convert between axis systems in exactly ONE function, never scattered fixes.

**Pivots:** ground-contact center for props, characters, vehicles. Grid corner (min X/Y/Z) for modular structural pieces. Floor slabs pivot at the corner of their TOP surface, so walk surface = 0.

**Modular grid:** 4.0 m module, 3.0 m wall height, 0.20 m wall/floor thickness. Snap: 1.0 m general, 0.5 m trim. Storey height 3 m; city block cell 4 m.

**Aperture sizes — both sets are valid, pick by building type:**

| | Door | Window | Sill |
|---|---|---|---|
| **Generous / institutional / industrial** | 1.20 × 2.20 m | 1.80 × 1.20 m | 1.00 m |
| **Domestic / tight / salvage-built** | 1.00 × 2.10 m | 1.20 × 1.20 m | 0.95 m |

Whichever you choose, **declare it once as a constant and use it everywhere** — the failure is mixing them, not picking one.

**Determinism:** every scene should be reproducible from data (JSON transforms, stable IDs, seedable randomness). Never "render and eyeball it" when you can measure.

**Addressing:** map any world position to a stable label like `L{level}-H{col}-R{row}` so every object is locatable and inspectable by address. *This earns its keep at scale: with ten identical containers, "the container is floating" is useless and `AST-CONTAINER-0043` is exact.*

**Scale classes:** if parts come in sizes (0.55× / 1× / 1.8×), connectors only mate within the same scale class. Bake scale into geometry at build time; never re-scale instances at runtime.

**Honesty about estimates:** derived/approximated values must be labeled as estimates, never presented as measured.

---

## PART 2 — PLACEMENT & ASSEMBLY DOCTRINE

### The placement contract principle

Every asset carries machine-readable placement metadata, so it is placed by solving, not guessing:

id · semantic role · units/axes · dimensions (size, bounds, grounded bounds — **measured at build, not authored**) · pivot (with rationale) · allowed rotations (90° steps for structural, free for props) · allowed scaling (1.0 structural / 0.75–1.5 props) · connectors `[local position + outward normal + tangent + tolerance + compatible roles]` · occupancy volume · clearance volume · **apertures (clear width/height — doors and windows stay traversable)** · collision hulls (convex decomposition WITH apertures carved out) · ground-contact points · snap points · surface compatibility `["flat","slope","wall","planetary"]` · foundation required above N° slope

### Assembly rules

- **Grounding:** `world_y = support_top + base_offset` — height is solved from what the object rests on, never hand-set.
  - **Corollary (v3):** if the ground is a heightfield, "support_top" is `heightAt(x,z)`, **never a constant**. Validating against y=0 on undulating terrain reports every asset on a rise as floating and every one in a dip as buried.
  - **Corollary (v3):** when graded pads flatten terrain under structures, **overlapping pads must not chain-blend.** Take the nearest pad's level outright. Sequential blending lets a distant pad's falloff drag the ground under a building that is nowhere near it.
- **Mating:** connectors join when positions coincide and normals are near-opposite within tolerance; solve yaw + translation together, and fail with a reason if no legal orientation exists.
- **Auto-seaming:** after placement, scan for connector pairs within reach and join them automatically.
- **Grid policies by role:** structural pieces snap to the module grid; roofs snap in plan with height solved; attached leaves (doors, windows) are positioned purely by connector solving; props ground freely.

### Validation rules every world must pass

Check and fix programmatically — with machine-applicable corrections (`{"translate":[x,y,z]}`), not vague warnings:

- ❌ floating assets (not supported by anything)
- ❌ buried assets (sunk into ground/other geometry)
- ❌ solid intersections — **use an oriented test, not world AABBs** (see 6B)
- ❌ collision proxies mismatched to visible extents (>0.40 m divergence)
- ❌ connector gaps or misaligned normals
- ❌ **blocked apertures** (something occupying a doorway/window volume)
- ❌ illegal rotation/scale for the asset class
- ❌ assets outside scene bounds
- ❌ duplicate or unstable IDs

Default tolerance 0.05 m. **Issue IDs deterministically hashed so runs are comparable.**

### PART 2B — DECLARED INTENT *(new in v3)*

**The most important addition in this revision.**

A validator that reports 67 problems of which 60 are intentional does not protect you — it trains you to ignore it, and then it misses the one that is real. Observed directly: a report sat at 67 issues and was skipped for days; once exemptions were added it went to 0, and the very next run caught two genuine faults that had been hiding in the noise the whole time.

So every asset may declare intent, and the checker honours it:

```ts
interface AssetFlags {
  belowGrade?: boolean;      // footings, sunk rubble — SUPPOSED to be underground
  unsupported?: boolean;     // held by geometry that isn't itself registered
  interpenetrates?: boolean; // interlocking rubble, stacked scrap
  dynamic?: boolean;         // moves at runtime; static checks don't apply
  outOfBounds?: boolean;     // deliberate distant set dressing
}
```

**Rules for exemptions**
1. An exemption is a *promise the author considered the case*, never a way to silence a warning you don't understand.
2. Exempt the narrowest thing that works — one asset, not a whole role, unless the whole role genuinely qualifies.
3. **Target zero.** A non-zero report means something is wrong. If you cannot get to zero, the remaining entries must be listed in the README with reasons.

### Reachability

Flood-fill the walkable volume against occupancy boxes to **prove** paths. Declare claims as data: `{"from": A, "to": B, "must": true}` (player can reach the roof) and `{"from": A, "to": B, "must": false}` (the vault stays sealed).

> **This catches containment bugs that look fine visually.** In production it would have caught two separate bugs — an interior room sealed by a wall standing in its doorway, and a ladder that rendered perfectly but could not be climbed. Both shipped. Both were found by a human walking into them. Implement this.

---

## PART 3 — GEOMETRY & CONTENT DOCTRINE

### Modular vocabulary principle

Design worlds from a small, complete vocabulary of parametric families:

- **Structure:** foundation pad, floor slab, floor-with-opening (stairwell), walls (straight, corner, doorway, window, interior), door leaf, window leaf, roofs (flat, pitched, ridge, hip corner, valley, trim), stairs (full + stoop), beam, column, railing, junction trim
- **Urban:** straight road, road+sidewalk, four-way intersection, terrain tile
- **Vehicles:** chassis, wheel assembly, tire, axle, wing panel, thruster
- **Systems:** battery module, wire/conduit, fuel tanks
- **Props:** crates, barrels, pallets, pipes, vents, signs, rubble, debris, workbench
- **Blueprints:** stall, cottage, boat, tree, cart, campfire, creature

### Parametric generation principle

Generate meshes from ONE config file of constants with a `validate()` that refuses impossible configs (door taller than wall, bevel wider than trim). The whole kit then re-rolls at different proportions with one command.

### Exact-boolean kernel pattern

For build-time assembly math, represent solids as sets of disjoint axis-aligned boxes: booleans become exact lattice arithmetic, occupancy IS the solid, clash tests are exact, and it runs anywhere. Carve apertures as recorded holes so "is this doorway still open" is answerable.

### Textureless shading recipe

Exact-boolean watertight manifold → Bevel (1.2 cm, 2 segments, 30° angle limit, harden normals) → Weighted Normal (keep sharp, weight 60) → full smooth. **Bevel width is the single biggest lever on how a pack reads.**
Budget: 38-piece kits under ~41,000 tris; simple walls ~620; hero props ~3,000.

### PART 3B — THE FORM HIERARCHY *(new in v3 — the detail brief)*

> This is the section that most changed output quality in practice. Given vague instructions an AI produces vaguely better boxes; given this hierarchy it produces assembled objects.

**Goal:** *assets that look designed and manufactured.* Every component should appear **mechanically or architecturally assembled, not booleaned together.**

**Primary forms** — the large recognizable shape.
House · Car · Sword · Tree

**Secondary forms** — the major components.
Doors · Windows · Roof sections · Hood · Wheels · Guard · Blade

**Tertiary forms** — construction details.
Hinges · Bolts · Rivets · Welds · Trim · Pipes · Vents · Handles · Panel seams

**Micro detail** — the material itself.
Scratches · Edge wear · Dust · Fingerprints · Paint chips · Wood grain · Concrete pores · Rust · Surface noise

**The working checklist**

- Increase silhouette complexity
- Add secondary and tertiary forms
- **Introduce bevels on exposed edges** — a perfectly sharp 90° edge is a rendering artifact, not an object. A 6–20 mm break catches a specular highlight and is most of what makes a form read as built.
- **Separate trim into independent meshes** — fascia, soffit, gutter and cover strips cast their own shadow lines; painted-on trim reads flat
- Add gutters, flashing, fascia, soffits, vents, hinges, bolts, and seams
- Improve texel density consistency
- Reduce visible texture repetition
- Add decals for dirt accumulation and weathering
- Verify real-world dimensions
- Ensure material response is physically accurate

**Implementation notes**

- Tertiary detail is *instanced*. Bolts and rivets number in the hundreds; they belong in an `InstancedMesh`, not hundreds of draw calls.
- Cache geometry by dimension. A world reuses a few dozen distinct sizes.
- Real dimensions are most of legibility. ISO container 6.058 × 2.438 × 2.591 m. Stair riser ≤ 0.20 m. Masonry 0.2 m. Human 1.78 m, head ≈ 1/7.5 of height.
- Build a **detailing kit module** (`bevelBox`, `bolts`, `rivets`, `seam`, `weld`, `hinge`, `vent`, `gutter`, `window`) so the whole world speaks one vocabulary instead of each asset being detailed ad hoc.

---

## PART 4 — MATERIALS & SURFACES DOCTRINE

### The material card principle

Every surface is a data card, not a vibe:

id (`MAT-CATEGORY-####`) · source type · license · **real-world size in meters** · default repeat · mapping methods `[uv | planar | box | triplanar | world]` · roughness 0–1 · metalness 0–1 · colorSpace · seamless (bool) · tileability 0–1 · **explicit null for missing maps — never silently substitute** · lifecycle draft → prototype → approved

### Reference values (real-photograph-derived, metalness 0)

| Surface | Roughness | Height | Tileability |
|---|---|---|---|
| Exposed-aggregate concrete | 0.94 | 0.07 | low (0.22) |
| Fine broomed concrete | 0.91 | 0.06 | medium (0.42) |
| Concrete pavers | 0.88–0.90 | 0.08 | 0.28–0.36 |
| Brick pavers | 0.84–0.88 | 0.10–0.16 | low |
| Asphalt | 0.84–0.90 | 0.06–0.14 | 0.18–0.36 |
| Rocky soil | 0.96 | 0.18 | low (0.18) |
| Tree bark | 0.90 | 0.20 | very low (0.12) |
| Broadleaf foliage | 0.78 | 0.04 | very low |
| Carpet | 0.98 | 0.08 | 0.46 |
| Pale stone pavers | 0.82 | 0.08 | 0.34 |
| Weathered wood | *directional — use triplanar* | | |

### Deriving maps from a single photo (estimates — label them)

From luminance L (Rec.709): `height = clamp((L − 0.22) × 1.45)` · `roughness = clamp(0.72 + (1 − L) × 0.25)` · `normal` = central differences, `dx = (L(x−1) − L(x+1)) × 2.4`

### Anti-tiling law

Non-seamless + repeatX > 1.5 → defect; any repeat > 5 → defect. Fix with a deterministic macro-noise layer (seeded LCG: seed 9137, multiplier 1664525, increment 1013904223; 128px, repeat ~1.4×1.1).

### PART 4B — ALBEDO SANITY *(new in v3)*

**Photographic texture sets are frequently far too dark to be physically plausible albedos, and this is invisible until you measure it.**

Measured from a shipped AI-generated atlas:

| cell | sRGB | linear albedo |
|---|---|---|
| worn leather | (44,33,23) | **0.021** |
| olive armour | (56,52,34) | **0.036** |
| olive canvas | (59,52,34) | **0.040** |
| cracked dirt | (121,100,80) | 0.193 |

Real worn canvas sits near 0.10–0.14 linear. **0.02 is darker than charcoal.** Under a low sun those surfaces crush to solid black and every downstream judgement about lighting is made through that fault.

- **Check the linear albedo of every base-colour cell before tuning lights.** Sanity floor ≈ 0.03, ceiling ≈ 0.85.
- Correct with a **gamma lift** (`pow(rgb, γ)`, γ ≈ 0.6–0.8) plus gain. A multiplicative colour tint **cannot** rescue a dark texture — multiplying only ever darkens.

### PART 4C — TEXEL DENSITY BY CONSTRUCTION *(new in v3)*

Mesh UVs make uniform texel density a per-asset chore, and beveled geometry makes it worse: `BoxGeometry` gives every face UV 0..1, so a 4 m wall face and its 0.2 m return edge resolve at 20× different density.

**Project from position along the dominant normal axis instead.** Density becomes one number — metres per tile — and is uniform across every face of every object sharing the material, by construction. The same shader injection then carries, for free:

- anti-tiling (a second sample at an incommensurate scale, e.g. ×0.173)
- ground-accumulated grime (darken toward world y = 0)
- settled dust on up-facing normals
- roughness variation for edge wear

**Project in world space for static geometry, object space for anything that moves** — world projection on a moving object makes the texture swim across it.

---

## PART 5 — ENGINE PIPELINE RULES

### Three.js / web

- GLBs load with GLTFLoader, Y-up, no rotation fix needed if exported correctly.
- **Dual-mode design:** beauty mode ↔ inspection mode (grid, IDs, bounds, collision proxies, validation report) in the same app.
- **Tone mapping is not optional.** With physically-scaled lights, no tone mapping clips every lit face to paper. Use ACESFilmic and drive exposure from time of day.
- **Shadow rig:** the shadow camera must FOLLOW the viewer. A fixed 160 m ortho frustum on a 2048 map is ~8 cm/texel — coarser than a person is wide, so small objects self-shadow into solid black. Track the viewer at ~90 m (~4.4 cm/texel), snap the centre to texel steps so edges don't crawl, and always set `bias` (≈ −0.0004) and `normalBias` (≈ 0.035).

**Mobile presets — both are valid, choose by content:**

| | Textures | pixelRatio | Shadows | Use when |
|---|---|---|---|---|
| **Conservative (v2)** | 512 px | ≤ 1 | static off | dense scenes, low-end targets, many draw calls |
| **Modern (v3)** | 1024–1536 px WebP | ≤ 2 | 1024 map, tracked | sparse scenes, few materials, texture-led look |

*Measured:* four 2048 PNG atlases = 32 MB and is fatal on mobile data; the same at 1536 WebP = 2.4 MB with no visible loss at 2–6 m tiling. **Compress before you downscale.**

### Unreal
Import FBX: Uniform Scale 1.0, Combine Meshes ON, Generate Lightmap UVs ON, Auto Collision ON, **Normal Import Method = "Import Normals and Tangents"** — recomputing normals softens bevels and ruins the textureless look. Then enable Nanite. Build LOD chains with Unreal's own reduction, LOD1–3 non-increasing. Scriptable headless via Python editor scripts.

### Unity
Import FBX: Convert Units ON, Scale Factor 1, Normals = Import. LOD chains wire into LODGroup.

### Blender
Append from a showcase-grid `.blend`; headless: `blender -b --factory-startup --python build_script.py`. Materials: card → Principled BSDF.

### Cross-engine laws
Convert coordinate systems in exactly ONE adapter function per engine. **Disable engine auto-collision for kit assets** — import the shipped hulls (auto hulls seal doorways).

---

## PART 6 — FAILURE LAWS (never do these)

- Never recompute normals on beveled assets at engine import.
- **Never let engine auto-collision near apertures — it seals doorways. Carve hulls instead.**
- Never hand-place what a contract can solve.
- Never silently down-scale something that doesn't fit — upgrade the container or reject with a reason.
- Never apply instance scale from sync/state — 1.8× becomes 3.24×.
- Never align tall buildings to terrain normals — they lean. Use foundations/pads.
- Never non-uniformly scale structural or snap-enabled assets at runtime.
- Never scatter axis fixes through gameplay code.
- Never use position-based touch routing — every pointer gets exactly one immutable owner assigned at pointer-down; reset globally on blur/visibility/orientation change.
- Never let movement survive input termination (`pointercancel`).
- Never fake entity yaw with camera orbit, and never make the movement plane pitch-dependent.
- Never let the camera clip geometry or jump in one frame — raycast + damped recovery.
- Never tile non-seamless textures past repeat 1.5 without macro-noise breakup.
- Never ship vegetation without a cutout map or wood grain without triplanar.
- Never present estimates as measured data.

### PART 6B — FAILURE LAWS LEARNED IN PRODUCTION *(new in v3)*

Each of these cost real debugging time. They are ordered by how much.

1. **Never construct scene objects before assets finish loading.** A class field initialiser runs in the constructor — *before* an async `init()` awaits texture loading. Objects built then slice from an empty cache and render solid black. *This produced a character that looked like an unlit slab and survived multiple sessions because every other explanation (shadows, materials, lighting, shaders) was plausible.*
2. **Never let a lookup fail silently to a usable-looking default.** `new CanvasTexture(undefined)` yields a black texture, not an error. **Throw.** A loud failure at build time is worth a hundred hours of "why is this dark."
3. **Never build one collider from a group's bounding box when the group contains an aperture.** The box spans the hole and seals it. Collide per child. *(This is Part 6's auto-collision law reappearing in hand-written code — the law is about the shape of the mistake, not the tool.)*
4. **Never treat a fixed timestep constant as delta time.** `dt = 1/60` makes the game run 2.4× fast on a 144 Hz display. Use real elapsed time, clamped (≈ 0.05 s) so a stall cannot tunnel anyone through a wall.
5. **Never reject a blocked move wholesale.** Testing the combined move and refusing it stops the player dead against any wall at any angle. Resolve X and Z independently so they slide.
6. **Never add an unstick guard without bounding it.** "If already inside geometry, allow any move" is correct and necessary — but it *disables collision entirely* while it applies. If an actor spawns inside geometry it silently walks through everything. Make spawn points prove they are clear.
7. **Never trust a world AABB for intersection once things rotate.** A 6.06 × 2.44 m box turned 0.9 rad has a 5.7 × 6.3 m axis-aligned box; two sitting 0.46 m apart report a 2.6 m overlap. Use a separating-axis test on the real boxes. *(Watch the sign convention: local +X maps to `(cos θ, −sin θ)`.)*
8. **Never include non-solid geometry in an asset's extents.** An open door leaf bulges its wall's box into the next room and reports an intersection that does not exist. Tag it and exclude it.
9. **Never let a validator report intentional design as error.** See Part 2B. Noise kills adoption, and an ignored validator is worse than none.
10. **Never set night lighting by physical plausibility alone.** Real moonlight renders as unplayable black. Set it by what stays legible on screen, lift exposure to compensate, and say plainly that you did.
11. **Never let two systems own the same input.** If "forward" drives both walking and ladder climbing, it will do both at once and walk the player off the ladder. One owner per input per state.

---

## PART 7 — CONTROLS, CAMERAS & FEEL

**Both value sets below are proven. The v2 column is the reference standard; the v3 column is a tighter, more modern third-person feel. Pick one per project and keep it consistent.**

| | v2 reference | v3 alternative |
|---|---|---|
| Dead zone | 0.12 | 0.12 |
| Walk / run | 4.2 / 7.4 m/s | 4.2 / 7.4 m/s |
| Turn speed | 12 | 14 |
| Look sensitivity | 0.0042 | 0.0024 (mouse) · 0.0052 (touch) |
| Pitch clamp | −55° / +70° | −62° / +72° |
| Camera distance | 6.2 | 4.6 (+0.55 shoulder offset) |
| Camera height | 1.45 | 1.52 |
| FOV | — | 68 → 76 on sprint |

**Universal, not optional:**
- Camera-relative basis: `forward = normalize(F − dot(F,U)·U)`, `right = normalize(cross(U, forward))`
- Camera collision: raycast + damped recovery (margin 0.24, min distance 0.65). **Damp, don't lerp** — a fixed lerp factor is frame-rate dependent.
- Walk→run threshold 0.72. Joystick 56 px visual radius, 48 px max displacement; respect safe-area insets.
- **Movement should accelerate**, not teleport to top speed. ~42 m/s² toward desired, ~30 back to rest, ~0.28 air control.
- **Gravity needs forgiveness windows:** coyote time ≈ 0.12 s, jump buffer ≈ 0.14 s. Without them a correct jump feels broken.
- **Step-up ≈ 0.52 m** so stairs at ≤ 0.20 m risers are walkable without special-casing.
- **Ladders are climb VOLUMES, not geometry.** A 20 mm rung is not something a capsule stands on. Inside the volume: suspend gravity, forward input drives vertical travel, hold the centre line, zero planar velocity, jump detaches. Stop the volume just above deck level — any higher and step-up lets the player mount the guard rail and walk off.

**Vehicles:** root forward +Z, up +Y, wheel axle +X, steering yaw +Y, positive throttle = +Z. Steering authority should fall off at low speed. Verify visual forward matches motion.

**Planetary scale:** radial up = `normalize(position − center)`; tangent-projected forward; gravity toward center; large structures in local tangent frames; floating origin / origin rebasing. Beware pole degeneracy and origin-rebase physics jumps.
> **Cost warning:** converting an existing flat-plane world to a true sphere is a rewrite, not a feature — every file assuming +Y up and an XZ plane is affected. If you only need the *look*, a vertex shader that bends distant terrain downward gives a planetary horizon with no physics change. Decide before you build, not after.

---

## PART 8 — BUILD PROTOCOL FOR NEW IDEAS

1. **Listen to the idea first.** Ask what matters: engine? scale? mood? gameplay vs cinematic?
2. **Design fresh.** Name original systems for THIS idea. The doctrine shapes *how* you build, never *what*.
3. **Define the vocabulary** the idea needs, using the contract schemas above.
4. **Stand up the enforcement layer (Part 9) before the content**, not after.
5. **Build deterministically** — data-driven scenes, stable IDs, measured dimensions, seeded randomness.
6. **Self-validate** with Part 2 checks + Part 6/6B failure laws; report what passed *and what you could not verify*.
7. **Deliver engine-ready** with the correct import rules from Part 5.
8. For cinematic work: light surfaces to their material data; emit scenes as reproducible JSON contracts.

---

## PART 9 — ENFORCEMENT & SELF-VERIFICATION *(new in v3)*

> Parts 1–8 say what correct looks like. This part is how correctness gets *checked*, and it is the difference between a doctrine that works and one that is merely true.

### 9.1 The scene report

Expose the registry as **structured data**, not only as labels in the world. Visual labels are right for a human standing in the scene; they are wrong for a tool — they get occluded, must be OCR'd off screenshots, and cannot be diffed.

```ts
sceneReport(): {
  generatedAt, world:{size,module},
  counts:{assets,issues,apertures,byRole},
  issues:[{ key, kind, id, role, address, amount?, with?, message, fix? }],
  assets:[{ id, role, address, pos, size, clearance, flags }]
}
```

- `key` — deterministic hash, so runs compare and a fix can be proven
- `fix` — machine-applicable `{translate:[x,y,z]}` where computable
- `clearance` — base height **relative to the terrain beneath**, not absolute

Ship `reportText()` too: a compact form that pastes straight into a conversation.

**Why this matters more than the visual layer:** screenshots show what *looks* wrong. The report shows what *is* wrong — including faults that look perfect. A house sitting 0.4 m into a ridge rendered flawlessly and was caught only by measurement.

### 9.2 Apertures as first-class objects

Register every doorway and window opening: `{id, ownerId, center, width, height, axis}`. Then Part 2's blocked-aperture check is a few lines, and the single most common structural regression — something standing in a doorway — is caught the moment it appears.

### 9.3 Regression diffing

```ts
snapshot()            // before a change
diffSinceSnapshot()   // → { added, removed, moved, newIssues, fixedIssues }
```

Nothing in a validation *list* answers "did I just break something that used to work." This does. Run it around any structural edit.

### 9.4 A live debug handle

In dev builds, expose the scene, renderer, camera, player, colliders and report API on one global. This turns "I think the material is wrong" into a measurement in one call. **Guard it behind a dev flag** so it never ships.

### 9.5 An automated visual harness

Drive the app headless (Playwright or equivalent): load, wait for ready, screenshot at desktop *and* mobile viewports, capture console errors, and step simulation deterministically at fixed `dt`.

**Two traps, both encountered:**
- A software renderer may run at ~2 fps. With a clamped `dt` the simulation crawls, and any timing test reads as broken when it is fine. **Step the simulation directly at fixed `dt` for logic tests**; use the render loop only for pictures.
- A test that holds "forward" indefinitely will walk the character off whatever it just climbed. Release input before asserting.

### 9.6 An on-screen text panel

Alongside world-space labels, render the nearest N assets as **screen-space text**: id, role, grid address, distance. Never occluded, always legible, and it makes a single screenshot enough for a human to report a bug precisely.

### 9.7 Reporting standard

When you finish a piece of work, state: what you changed, **what you verified and how**, what you could not verify, and what you deliberately left undone. Include the numbers. If a validator says 0 issues, say what it checks — a green light from a weak test is worse than no test.

---

## END OF DOCTRINE

The floor is yours. Pitch the new world.
