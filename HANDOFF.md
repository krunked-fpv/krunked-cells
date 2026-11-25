# KRUNKED CELLS — Sprint Handoff

## Shipped State
Krunked Cells v1.0 is complete, verified across all three empirical gates, and registered in `C:\KrunkedVault`.

- **Architecture:** Strict TypeScript + Vite + Vitest + WebGL2 + Canvas/DOM Gothic HUD + Web Audio API. Pure deterministic 60 Hz simulation (`src/sim/**`) decoupled from 30/60/120 FPS interpolated rendering (`src/render/**`).
- **Gameplay & Content:** 20 weapons (16 offense + 4 shields with oracle-calibrated strike chains), 12 skills, 15 mutations, 18 status-synergy affixes, 18 enemies + 4 Elite affixes, 10 campaign biomes + Passage safe room (Timed & 30/60 Kill-Streak doors, Collector blueprints, Guillain mutations, Minor Forge upgrades/reforges, Health Fountain), 3 multi-phase bosses (`Behemoth` 4000 HP, `TimeKeeper` 2500 HP, `KingsHand` 5900 HP), and 0BC–5BC Boss Stem Cell progression persisted in `krunked_cells_save_v1`.
- **Graphics & Dual-Mode Art:** 4-pass 480×270 `gl.NEAREST` WebGL2 compositor (Parallax Backdrop → MRT G-Buffer with flipped-sprite `n.x` inversion → 64-light cel-shaded normal mapping → volumetric fog, weather, separable bloom & ACES Filmic composite). Ships with a 387-key procedurally baked Albedo+Normal+Emissive atlas plus live Owned Custom Pack loader (Vite `/__custom_pack__/` middleware + Folder Picker + IndexedDB) with Dead Cells `*_default_s.png` Skin LUT decoding and `headBone` tracking.

## Verification Proof
- **Gate A (`npm run verify:assets`):** `7/7 PASS` — 0 retail/pack leaks in `git ls-files` and `dist/`, 242 extracted custom-pack files verified, full Oracle Parity against `.krunked-cells-assets/oracle.json`.
- **Gate B (`npm run test && npm run verify:sim`):** `37/37` Vitest tests pass (including 56-seed BFS worldgen reachability); `23,860`-tick full campaign soak clears all 8 stages, 7 Passage rooms, 36 parries, and all 3 bosses (`P1->2->3`), unlocking `1BC` with bit-identical replay hash (`82387250`).
- **Gate C (Live Browser Red-Team):** 3 visual audit passes at `http://localhost:4173/`; `0` console errors, `0` failed network requests across Built-In Art and Custom Pack modes.

## Candidate Next-Sprint Enhancements
1. Add optional custom-pack biome tileset swapping (auto-tiling extracted `prison`/`sewer`/`castle` atlases alongside characters and bosses).
2. Expand Challenge Rift mini-arenas, Daily Challenge seeded leaderboards, and additional DLC-inspired weapons/biomes.
3. Add 1BC–5BC Malaise meter and Boss Rush gauntlet mode.
