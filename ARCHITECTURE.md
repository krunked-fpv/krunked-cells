# KRUNKED CELLS — System Architecture

## 1. Foundry Design Principles
Krunked Cells is a deterministic, spliceable WebGL2 + TypeScript roguelite action-platformer built to the Krunked Foundry standard:
- **Zero-Coupling Simulation Core (`src/sim/**`)**: Pure 60 Hz (`SIM_HZ = 60`, `FIXED_DT = 1/60`) deterministic state machine. Zero DOM, Canvas, WebGL, AudioContext, `Date.now()`, `performance.now()`, or `Math.random()`.
- **Canonical Contracts (`src/contracts/index.ts`)**: Single source of truth for `SimState`, `InputFrame`, `SimEvent`, `SimCommand`, `RenderSettings`, `SaveData`, `AssetManifest`, and `DebugBridge`.
- **Multi-Pass WebGL2 Pixel-Art Lighting (`src/render/**`)**: 480×270 logical FBO compositor with `gl.NEAREST` crisp upscaling, tangent-space normal mapping (with flipped-sprite `n.x` inversion), up to 64 real-time dynamic point lights, biome cel-shadow shading, drifting volumetric fog, weather particles, and additive bright-pass bloom.
- **Dual-Mode Art & Audio Pipeline**: Ships 100% playable and visually breathtaking out of the box with original procedurally-baked pixel-art atlases (paired Albedo + Tangent Normal + Emissive) and original Web Audio baroque-dark-synth soundtrack. Optionally loads an owned local Dead Cells pack via Vite dev middleware (`/__custom_pack__/`) or client-side Folder Picker + IndexedDB cache, strictly separated by an IP Firewall.

## 2. Module Topology & Exclusive Ownership

```
c:\krunked-cells\
├── .agents/agents/          # 8 specialist role specs (@architect)
├── .github/workflows/ci.yml # Typecheck, verify:assets, test, verify:sim, build, Pages (@architect)
├── tools/
│   ├── extract-assets.ts    # Read-only PAK v1 extractor -> .krunked-cells-assets/ (@extractor)
│   └── oracle-dump.ts       # Read-only data.cdb oracle extractor (@extractor)
├── scripts/verify/
│   ├── verify-assets.ts     # Gate A: key resolution, oracle check, IP firewall (@extractor)
│   ├── verify-sim.ts        # Gate B: full headless campaign soak + replay hash (@playtester)
│   └── export-dna.ts        # Stage 2: sync GAME_DNA.md & genome.json -> C:\KrunkedVault (@playtester)
├── src/
│   ├── contracts/index.ts   # Single source of truth types & constants (@architect)
│   ├── data/                # Oracle-calibrated catalogs (@gameplay)
│   │   ├── biomes.ts, weapons.ts, skills.ts, mutations.ts, affixes.ts
│   │   ├── enemies.ts, bosses.ts, difficulty.ts, meta.ts, index.ts
│   ├── sim/
│   │   ├── prng.ts, hash.ts, collision.ts, physics.ts, worldgen.ts, camera.ts, step.ts (@simcore)
│   │   ├── status.ts, combat.ts, enemies.ts, bosses.ts, roguelite.ts, passage.ts (@gameplay)
│   ├── assets/              # Built-in procedural normal-mapped pixel atlas + Custom Pack loader (@renderer)
│   ├── render/              # WebGL2 4-pass normal-mapped compositor + shaders + particles (@renderer)
│   ├── audio/               # Dual-mode Web Audio engine (Built-in Synth + Custom Pack WAV/OGG) (@audio)
│   ├── input/               # Keyboard + Mouse aim + Gamepad + rebindable map (@uiux)
│   ├── ui/                  # HUD Canvas/DOM overlay, Minimap+Teleport, Passage Modals, F9 Drawer (@uiux)
│   └── app/                 # GameApp (fixed-timestep loop + 30/60/120 FPS pacing), SaveManager, DebugBridge (@architect)
├── tests/                   # Comprehensive Vitest unit & integration suites (@playtester)
└── dna/genome.json          # Machine-readable Mashup DNA Vault manifest (@playtester)
```

## 3. Runtime Dataflow (Per Frame)

1. `InputManager` polls Keyboard / Mouse / Gamepad and produces an `InputFrame` (plus queued `SimCommand[]` from UI interactions such as Scroll choice, Passage NPC actions, or Minimap Teleport).
2. `GameApp` advances an accumulator in `FIXED_DT = 1/60` increments (clamped to avoid spiral of death), calling `stepSim(state, inputFrame)` strictly on simulation ticks.
3. After each tick, `GameApp` drains `state.events` into `Renderer.ingestEvents()` and `AudioEngine.ingestEvents()`, and updates biome/boss music tracks.
4. `GameApp` renders at `renderSettings.targetFps` (`30 | 60 | 120`, default `120`) passing `interpAlpha = snapToSimRate ? 1 : accumulator / FIXED_DT` into `WebGL2Renderer.render(state, interpAlpha, elapsedSec)`.
5. `UIManager` updates crisp native-DPI HUD, interactive Minimap, Loot comparison cards, Passage NPC modals, Boss banners, and the optional `F9` Dev Playtest Drawer.

## 4. Clean-Room IP Firewall
- `.krunked-cells-assets/` is listed in `.gitignore`.
- `tools/extract-assets.ts` and `tools/oracle-dump.ts` open `res.pak` in strict read-only mode (`'r'`).
- `scripts/verify/verify-assets.ts` asserts ZERO tracked files in `git ls-files` and ZERO files inside `dist/` originate from retail archives (`.pak`, `.cdb`, `.hdll`, `.exe`, `.dll`, or `.krunked-cells-assets/`).
