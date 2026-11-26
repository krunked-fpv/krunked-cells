# KRUNKED CELLS — Sprint Handoff & Completion Summary

> **Status:** **Dead Cells Parity Overhaul & Gate C Visual Red-Team Sprint 100% COMPLETE** (2026-11-25)
> **Branch:** `main` (clean working tree; local `main` is ahead of `origin/main` — **unpushed** until the user explicitly approves `git push origin main`).
> **Research Blueprints (Persistent Reference):**
> - Mechanics & Combat Blueprint: `C:\Users\alexg\.gemini\antigravity\brain\76b36757-6a29-4a96-b545-e7f0a548ca90\scratch\PARITY_MECHANICS_BLUEPRINT.md`
> - Visuals, Shaders, VFX, UI & Audio Blueprint: `C:\Users\alexg\.gemini\antigravity\brain\76b36757-6a29-4a96-b545-e7f0a548ca90\scratch\PARITY_VISUALS_BLUEPRINT.md`

---

## 1. Merged Milestones on `main` (10/10 Landed)

### Wave 1 — Shaders, Contracts, Audio & Built-In Multi-Frame Art
1. **`render-shaders` (`e76a334`)**: Dual `{ diffuse, emissive }` `#ff00ff` sentinel extraction in `CustomPackLoader.ts`; 8 biome-distinct `PARALLAX_FRAG` styles (`u_biomeStyle` 0..7) + 4-layer custom scrollers; deeper cel shadows (`0.36`), point-light shoulder (`0.34`), metallic `specRim`, crevice `FOG_FRAG`, and `u_zoom`/`u_chromaSplit`/`u_curseIntensity`/`u_lowHpPulse` in `Shaders.ts`; `ParallaxBackdrop.ts` biome mappings.
2. **`contracts-audio` (`5cc468b`)**: Parity extensions in `src/contracts/index.ts`; Boss music precedence, `'title'` Prologue music, `preloadCoreCustomSfx()`, ascending Cell Pickup Combo Scale, and upgraded `SynthSfx` across `AudioEngine.ts`, `SynthSfx.ts`, `tools/extract-assets.ts`, and `GameApp.ts`.
3. **`art-builtin` (`7ad3dc2`)**: `106` multi-frame original sprites + `320×180` title backdrop baked cleanly into `src/assets/builtinArtData.ts` (`BUILTIN_HERO_HEAD_ANCHORS_DATA` for live `hero:head_flame_0..3`, 4-pose Bosses, 64-frame zero-clone Enemies) and `2048×2048` `ProceduralAtlas.ts` (`698` keys, 12-tile biome autotiling, 15 architectural props, 20 painterly VFX).

### Wave 2 — Core Sim, UI/HUD, Combat/AI/Bosses & Render VFX
4. **`sim-core` (`357aabe`)**: `42t` roll cadence + flat air-roll glide, `132px` roll-cancellable fall stun, 2-tier Ram Dive-Slam + `6×3` cellars, Spider wall-run + `6t` away-lock + `7t` coyote + `20px` auto-mantle, closed-door LOS blocking, grounded vertical camera peek + fast-fall look-down, elastic bouncing coins/cells, Recycling Tubes, Merchant Shop Reroll & Food Shop, Challenge Rifts, Boss Arena parity, `++`/`S`/`L` `bonusScrolls`, 5BC Malaise, Gold Reserves, Sovereign Throne victory walk, and biome-distinct macro layouts.
5. **`ui-hud` (`1205793`)**: True combo-speed `DPS` + radiant gold `Crit DPS` + `Crit Condition` anchored hover tooltips, 5th Amulet slot, Boss Intro Splash Cards, per-biome 30/60 Kill-Streak badge, `.dc-curse-vignette` + `tempShieldHp` + 5BC Malaise bar, Merchant Reroll & price tags, 4-slot Recycling Tube preview, Flawless Boss Door & Legendary Forge UI, and gamepad `cameraPeekY`.
6. **`gameplay-parity` (`0475c81`)**: `80%` Oracle Rally + `0.5s` on-hit shield forcefield, Boss `15%` single-hit cap + CC diminishing returns + Freeze Shatter, 5-stack Bleed Hemorrhage Burst, Stuck Arrows, wall-piercing Inquisitor bolts, `36t` whiff / `0t` parry + `16t` frontal hold-block, all 20 weapons & 12 skills, all 18 Enemy AI signatures, full 3 Boss movesets (including HoTK floating invulnerable add-summons & Throne Ice Platforms), fixed Mutations, filtered Affixes, and Flawless/3-choice Passage altars.
7. **`render-vfx` (`a215bba`)**: Multi-pass Custom Pack boss emissives & 4-layer scrollers, 12-tile autotiling, multi-frame hero/enemy/boss rendering with `head_flame` neck-socket mounting, painterly slash smears & chain-lightning arcs, split Verlet scarf behind hero, wood splinters/gibs/wisps, 128-slot floor decal ring buffer, spring-pop `!` / `!!` telegraphs, world Curse skull, and zoom/chroma/curse composite uniforms.

### Wave 3 — QA Parity, Forensic Tests & Gate C Visual Polish
8. **`qa-parity` (`b43f5f0`)**: Fixed `ensureFountainCounters` BC clamping (`src/sim/passage.ts`) and post-carve grounded `ClockTower` spawns (`src/sim/worldgen.ts`), aligned `scripts/verify/playtest-100.ts` to authentic Dead Cells parity (`100/100`), and verified all 13 forensic parity regression tests in `tests/`.
9. **`ui-polish` (`5fb778a`)**: Repositioned `.kc-loot-card` / `.kc-merchant-bar` / `.kc-tube-card` at `1280×720` to clear bottom-left HUD (`src/styles.css`), cleared stale biome toasts upon entering boss arenas (`src/ui/HudOverlay.ts`), and aggregated/staggered concurrent gold & cell floaters.
10. **`render-polish` (`1dac6f5`)**: Added opaque `backWalls`/built-in masonry fill + top-10px `floorStamp` trim eliminating Custom `Castle`/`Throne` striping, lifted `Sewer` masonry & filtered `chains` (`reg.w <= 16`) in `WebGL2Renderer.ts`, generalized `sanitizeMagentaSentinels` across all non-LUT atlases + calibrated `Behemoth`/`KingsHand` LUTs in `CustomPackLoader.ts`, stabilized Verlet scarf velocity/anchor jumps in `AtmosphereParticles.ts`, and removed duplicate world shop price digits.

---

## 2. Final Verified Metrics (Current `main` + Closeout Sync)

- **`npm run typecheck`**: **PASS** (`0` TypeScript errors)
- **Gate A (`npm run verify:assets`)**: **PASS (`pass=5, skip=2, fail=0`)** in share worktree (`0` retail/pack leaks across `84` tracked files + `4` `dist/` entries; optional gitignored `.krunked-cells-assets/{manifest,oracle}.json` skipped in fresh worktree; `weapons=20, skills=12, enemies=18, bosses=3, biomes=11, mutations=15`, `SCROLL_DAMAGE_BASE=1.15`, `6` difficulties, boss HPs `4000/2500/5900`)
- **Vitest (`npm test`)**: **4/4 files, 64/64 tests PASS** (`physics-collision.test.ts` 15, `abilities-parity.test.ts` 18, `combat-roguelite.test.ts` 21, `worldgen-passage-save.test.ts` 10 including 56-seed BFS reachability & all 13 forensic parity tests)
- **Gate B (`npm run verify:sim`)**: **PASS** (`24,112` ticks / `401.9s` sim time, `0` NaNs, `0` OOB tunneling, `0` softlocks, `52` kills, `34` parries, all 8 biomes + 3 bosses `P1->2->3`, `runStatus=victory`, `bossCellsUnlocked=1BC`, bit-identical replay `13c65986 === 13c65986`)
- **100-Playtester Gauntlet (`npx tsx scripts/verify/playtest-100.ts`)**: **100/100 PASSED (100%)**, Avg Score `100/100`, **`0` CRITICAL, `0` MAJOR, `0` MINOR**
- **Gate C Live Browser Visual Red-Team Audit (`http://localhost:4173/`, `1280×720`, Round 2 Dual-Mode Built-In & Custom Pack)**: **PASS** (**`0` CRITICAL, `0` MAJOR**, `0` console JS errors, `0` `pageerror`, `0` HTTP `>=400`/404s, `0` WebGL `gl.getError()`)
- **Production Build (`npm run build`)**: **PASS** (`vite build`, `54` modules transformed)
- **Mashup DNA Export (`npm run export:dna`)**: **PASS** — synced `GAME_DNA.md` & `dna/genome.json` to `C:\KrunkedVault\games\krunked-cells` and updated `C:\KrunkedVault\CATALOG.md`

---

## 3. Repository & Next Step

- **Tree Status:** Clean working tree after commit; `node_modules` and `.krunked-cells-assets` remain strictly gitignored (`0` binary leaks).
- **Remote Status:** Local `main` is ahead of `origin/main` and remains **unpushed** pending explicit user approval (`git push origin main`).
