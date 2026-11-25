# Krunked Cells

A deterministic 60 Hz WebGL2 + TypeScript roguelite action-platformer built for the **Krunked Foundry**, featuring pixel-crisp 2D normal-mapped dynamic lighting, instant roll/parry-cancel combat, procedural Metroidvania biomes, 3 multi-phase bosses, Passage meta-progression, and 0BC–5BC Boss Stem Cells.

## Highlights
- **4-Pass WebGL2 Normal-Mapped Pixel Lighting (`480×270`, `gl.NEAREST`):** Up to 64 real-time dynamic flickering lights, tangent-space normal maps with flipped-sprite `n.x` inversion, deep biome cel-shaded shadows, multi-layer moonlit gothic parallax skylines, drifting ground fog, biome weather, and ACES Filmic additive bloom at `30 / 60 / 120` FPS.
- **Dual-Mode Art & Audio:** Plays out of the box with a procedurally baked 387-key Albedo + Tangent Normal + Emissive pixel-art atlas and original baroque-dark-synth Web Audio soundtrack. Optionally loads your own locally extracted Dead Cells custom pack (including normal maps, `*_default_s.png` skin LUTs, `headBone` tracks, and WAV/OGG audio) via Vite dev middleware or the in-game `LOAD CUSTOM PACK` folder picker — protected by a strict IP Firewall.
- **Full Roguelite Campaign:** 20 weapons (16 offense + 4 shields), 12 skills, 15 mutations, 18 status-synergy affixes, 18 enemies + Elites, 10 branching biomes + The Passage safe room (Timed & 30/60 Kill-Streak doors, The Collector, Guillain, Minor Forge, Health Fountain), 3 multi-phase bosses (**The Iron Concierge**, **The Chrono Warden**, **The Sovereign Hand**), and `0BC -> 5BC` difficulty scaling.
- **Pure Deterministic Simulation Core:** Zero DOM/WebGL/Clock/`Math.random` usage inside `src/sim/**`, SplitMix32/xoshiro128** PRNG, sub-stepped swept AABB collision, tile-space BFS reachability validation, and bit-for-bit reproducible FNV-1a state hashes.

## Quickstart

```bash
npm install
npm run play      # Launch local dev server at http://localhost:4173/
```

### Optional Local Custom Pack Extraction (Strictly Read-Only)
If you own Dead Cells installed locally on Steam (`C:\Program Files (x86)\Steam\steamapps\common\Dead Cells\res.pak`), extract the gitignored local pack and oracle reference:

```bash
npm run oracle    # Dumps .krunked-cells-assets/oracle.json
npm run extract   # Extracts curated atlases, normals, skin LUTs & audio into .krunked-cells-assets/
```

Then start `npm run play` and click **USE CUSTOM PACK** on the Title Screen (or toggle live in `F9` Dev Drawer / Options).

## Controls (Rebindable in Options + Gamepad Supported)
- `A / D` (or Arrows): Move | `W / S`: Climb / Crouch
- `Space`: Jump / Double Jump / Wall-Jump (`S + Space`: Drop-Through / Air Dive-Slam)
- `Shift`: Dodge Roll (21 iframes, door smash, instant attack cancel)
- `J` / `LMB`: Primary Weapon | `K` / `RMB`: Secondary Weapon / Shield Parry
- `Q / E`: Skill 1 / Skill 2 | `R`: Health Flask
- `F`: Interact / Equip | `Tab`: Expand Minimap & Teleportation Runes
- `Escape`: Pause | `F9`: Dev Playtest & Telemetry Drawer

## Verification & Build Scripts

```bash
npm run typecheck      # Strict TypeScript check
npm run verify:assets  # Gate A: Asset key resolution, Oracle Parity & IP Firewall
npm run test           # Gate B: 37 Vitest unit & integration suites
npm run verify:sim     # Gate B: Full headless deterministic campaign soak & replay hash
npm run verify         # Runs typecheck + verify:assets + test + verify:sim
npm run build          # Static production bundle in dist/ (GitHub Pages ready)
npm run export:dna     # Syncs GAME_DNA.md & dna/genome.json to C:\KrunkedVault
```
