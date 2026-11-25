# KRUNKED CELLS — Sprint Handoff & Resume Checkpoint

> **Status:** **PAUSED AT CLEAN CHECKPOINT** (2026-11-25 16:53 EST) — awaiting user `"ready"` signal to resume Wave 2 closeout + Wave 3 verification & visual red-team.
> **Branch:** `main` at `0475c81` (clean working tree; local `main` is ahead of `origin/main` — unpushed until user explicitly approves `git push`).
> **Research Blueprints (Persistent Reference):**
> - Mechanics & Combat Blueprint (80 KB): `C:\Users\alexg\.gemini\antigravity\brain\76b36757-6a29-4a96-b545-e7f0a548ca90\scratch\PARITY_MECHANICS_BLUEPRINT.md`
> - Visuals, Shaders, VFX, UI & Audio Blueprint (60 KB): `C:\Users\alexg\.gemini\antigravity\brain\76b36757-6a29-4a96-b545-e7f0a548ca90\scratch\PARITY_VISUALS_BLUEPRINT.md`

---

## 1. Completed & Merged on `main` (Deep Dead Cells Parity Overhaul)

### Phase 1 — Deep Parity Research (100% Done)
- Crawled `deadcells.wiki.gg`, `deadcells.fandom.com`, Dead Cells technical post-mortems, and retail `oracle.json`; audited every module in `src/`.
- Produced `PARITY_MECHANICS_BLUEPRINT.md` (12 prioritized veteran tells + exact formulas) and `PARITY_VISUALS_BLUEPRINT.md` (5 visual/audio pillars + zero-conflict file lanes).

### Wave 1 — Foundation, Shaders, Contracts, Audio & Multi-Frame Built-In Art (100% Merged)
1. **`render-shaders` (`e76a334`)**:
   - `src/assets/CustomPackLoader.ts`: Dual `{ diffuse, emissive }` extraction from Dead Cells `#ff00ff` glow sentinels (`behemoth`, `timeKeeper`, `HotK`, `beheaded`, `zombieWorm`) + rebalanced boss LUT iron shadow lift & tan highlight tame.
   - `src/render/Shaders.ts`: 8 biome-distinct procedural `PARALLAX_FRAG` styles (`u_biomeStyle` 0..7) + 4-layer custom scroller support; deeper cel shadows (`0.36`), relaxed point-light shoulder (`0.34`), and foreground metallic `specRim` in `LIGHTING_FRAG`; crevice-weighted `FOG_FRAG`; `u_zoom`, `u_chromaSplit`, `u_curseIntensity`, `u_lowHpPulse`, `u_time` in `COMPOSITE_FRAG` (all 7 GLSL programs verified 0 GL errors in headless Chrome WebGL2).
   - `src/render/ParallaxBackdrop.ts`: Fixed `Castle`/`Throne` -> `'dookuCastle'`, `ClockTower`/`TopClockTower` -> `'ossuary'`, exposed `biomeStyle` and 4-layer `setCustomScrollerTextures`.
2. **`contracts-audio` (`5cc468b`)**:
   - `src/contracts/index.ts`: Backward-compatible parity extensions (`CritCondition` `stuckArrows3`/`oiled`, `WeaponDef.blockDrPct`, `DifficultyDef`, `PlayerState`, `EnemyState`, `ProjectileState`, `BossArenaState`, `PassageState`, `SimState` fountain counters, `MetaSnapshot` bankedGold/Legendary Forge, `ShrineState` merchant/recyclingTube, `PickupState` shopId/choiceGroupId, `SimCommand` +3, `SimEvent` +8, `InputFrame.cameraPeekY`, `AudioEngineAPI.setTitleMusic`).
   - `src/audio/AudioEngine.ts`, `src/audio/SynthSfx.ts`, `tools/extract-assets.ts`, `src/app/GameApp.ts`: Fixed Boss music precedence (`[biomeId, 'boss', ...]`), wired `'title'` Prologue music, routed `playUiClick` through Custom Pack WAVs, blocked `jingle_elite_pop` on `cellSpawn`, fixed `enemyTelegraph`, wired all 9 previously unused extracted SFX, added `preloadCoreCustomSfx()`, added ascending pentatonic/major **Cell Pickup Combo Scale** (Custom + Built-In), and upgraded `SynthSfx` (3-stage door splinter, electric whip-crack CRIT, FM steel-bell parry clang + ducking, rising 2-tone `!` zing).
3. **`art-builtin` (`7ad3dc2`)**:
   - Generated 15 multi-frame original pixel-art sheets and baked them cleanly into `src/assets/builtinArtData.ts` (`207.2 KB` raw TS, `106` multi-frame original sprites + `320x180` title backdrop, `0` binary leaks — Gate A PASS):
     - **Headless Hero (18 true frames)** (`run_0..5`, `attack_0..2`, `parry`, `dive_slam`, `heal`, `idle_0..1`, `jump`, `fall`, `roll_0..1`) + `BUILTIN_HERO_HEAD_ANCHORS_DATA` (25 exact neck-socket coords for live `hero:head_flame_0..3`).
     - **3 Bosses (12 true frames, 4 distinct combat poses each)**: `Behemoth`, `TimeKeeper`, `KingsHand`.
     - **All 18 Enemies (64 true frames — ZERO palette clones!)**.
   - `src/assets/ProceduralAtlas.ts`: Expanded to `2048x2048` (`698/698` keys), added 12-tile biome autotiling, 15 biome/shop/tube architectural props, and 20 painterly VFX sprites (`slash_*`, `shield_guard`, `parry_burst`, `wood_splinter_0..2`, `gib_0..2`, `soul_wisp`, `decal_*`, `coin_0..3`, `curse_skull_world`, `telegraph_danger`).

### Wave 2 — Core Sim, Combat/AI/Bosses & UI/HUD (3 of 4 Merged!)
4. **`sim-core` (`357aabe`)**:
   - `src/sim/{physics,collision,camera,worldgen,step}.ts`: Roll cooldown (`42t` / 18t post-roll), flat air-roll glide, high-fall dizzy stun (`>=132px`) + roll-cancel, 2-tier Ram Rune Dive-Slam + real `6x3` subterranean cellars, Spider wall-run dual probes + wall-kick away-lock + `7t` coyote + `20px` auto-mantle, wood-door smash even when open, closed wood door LOS blocking, grounded vertical camera peek + fast-fall look-down + zoom punch, elastic bouncing coins/cells + silky curved cell homing, starting pedestals / Recycling Tubes, Merchant Shop Reroll + authentic Food Shop, Challenge Rift gauntlets, Boss Arena parity (no cheese balconies on Bridge/Clock Room, Throne destructible Ice Platforms, intro engagement gate), `++`/`S`/`L` gear `bonusScrolls`, per-biome `killStreak` reset, fountain counters, 5BC Malaise, Gold Reserves death-bank, Sovereign Throne `[F]` victory walk, and biome-distinct macro layouts (`PrisonCourtyard` boulevard, `Sewer` tunnels, `ClockTower` 4x6 vertical tower, `Castle` royal halls).
5. **`ui-hud` (`1205793`)**:
   - `src/ui/{HudOverlay,PassageModal,index}.ts`, `src/input/InputManager.ts`, `src/styles.css`: True combo-speed `DPS`, radiant gold `Crit DPS`, `Crit Condition`, `bonusScrolls`, golden `★` synergy affixes, 5th Amulet slot, anchored hover tooltip cards above every equipped slot + ground loot comparison deltas, cinematic Boss Intro Splash Card (`bannerTicks`), per-biome 30/60 Kill-Streak badge with crimson crack/shake + gold milestone flash, `.dc-curse-vignette` + temp shield HP cap + 5BC Malaise bar, ballistic floating damage numbers, Merchant Shop Reroll & category pills + world-space gold price tags + 4-slot Recycling Tube preview, Flawless Boss Door & post-boss Legendary Forge UI in `PassageModal`, and gamepad right-stick `cameraPeekY`.
6. **`gameplay-parity` (`0475c81`)**:
   - `src/data/**`, `src/sim/{combat,status,enemies,bosses,roguelite,passage}.ts`: Oracle Rally (`80%` pool, `36t` hold, `12%` hit capped at `20%` of `rallyLostAnchor`, `0.5s` on-hit shield forcefield), Boss `15%` single-hit cap + CC diminishing returns + Freeze Shatter, 5-stack Bleed Hemorrhage Burst, Stuck Arrows (`FastBow`/`BarbedTips`), wall-piercing Inquisitor bolts, bouncing/rolling fuse bombs, simultaneous multi-projectile parry reflect (`36t` whiff / `0t` success) & frontal-only `16t` hold-block (Rampart 85% DR, Cudgel/Bloodthirsty block passives), all 20 weapons & 12 skills (Electric Whip hitscan chain-lightning + water crit, Pyrotechnics oil-only crit, Balanced Blade 6-hit 10-stack, Phaser universal melee empower, Tonic `tempShieldHp` barrier, Corrupted Power shock aura, turret tether), all 18 Enemy AI signatures (turn delay, Dark Tracker teleport-first 26t windup, Worm death-eggs, Protector stationary aura, Scorpion burrow, Pirate rolling cannonball, Royal Guard/Lancer, 4BC+ teleport), all 3 full Boss movesets (Concierge Shout Stun + bilateral Fire Strike; Time Keeper 70%/50% + Sword Combos + Shuriken Shield + real Hook-Pull-Slash + P3 Sword Rain + 3x Lightspeed Dash; HoTK 85%/40% floating invulnerable Add-Summon + 6-Bomb Flurry + Symmetrical 3-hit Lance hitting behind on hit 2 + 3 Banners + Super Telluric Slam + P3 Double Charge + Throne Ice Platforms), fixed Mutations (Vengeance 8s, Predator stealth, Melee slow-only, WDLM 4s CD, Barbed Tips stuck-arrow DoT), filtered Affixes, Flawless Boss Door & 3-choice bonus door altars.

---

## 2. In-Flight Work Preserved Safely (1 Branch Ready to Merge on Resume)

- **`render-vfx`** (worktree: `C:\Users\alexg\.gemini\antigravity\worktrees\76b36757-6a29-4a96-b545-e7f0a548ca90\swarm-render-vfx-4acedeb1`, branch: `swarm-render-vfx-4acedeb1`, exclusive files: `src/render/WebGL2Renderer.ts` & `src/render/AtmosphereParticles.ts`):
  - Already authored **2,676 insertions** wiring Custom Pack boss emissive textures + status/elite tints, 4-layer Custom Pack scrollers, Built-In 12-tile autotiling + 15 biome/shop/tube props, multi-frame Built-In hero/enemy/boss poses + live `hero:head_flame_0..3` neck-socket mounting via `BUILTIN_HERO_HEAD_ANCHORS`, painterly weapon-class slash smears & chain-lightning arcs, 2 split Verlet scarf ribbons rendered **behind** the hero, bouncing wood splinters & enemy gibs + soul wisps, 128-slot persistent floor decal ring buffer, spring-pop `!` / crimson `!!` telegraphs, overhead world-space Curse skull, and `COMPOSITE_FRAG` `u_zoom`/`u_chromaSplit`/`u_curseIntensity`/`u_lowHpPulse`.
  - Instructed at pause (#53) to finish committing on its branch and park cleanly. **DO NOT kill `render-vfx` until its branch is checked, verified, and merged onto `main`!**

---

## 3. Empirical Status at Pause Checkpoint (`main` @ `0475c81`)

- **`npm run typecheck`**: **PASS** (0 errors)
- **Gate A (`npm run verify:assets`)**: **PASS (`7/7 PASS`, `0` fail, `0` binary leaks)**
- **Gate B (`npm run verify:sim`)**: **PASS** (`23,581` ticks, 0 NaNs, 0 OOB, 0 softlocks, all 8 biomes + 3 bosses `P1->2->3`, 1BC unlocked, bit-identical replay `072e187b === 072e187b`)
- **Vitest (`npm test`)**: **60/61 PASS** (1 isolated cross-branch bug below!)
- **100-Playtester Gauntlet (`scripts/verify/playtest-100.ts`)**: **72/100 PASS** (1 real worldgen bug + pre-parity test assertions below!)

### Exact 2 Real Sim Bugs Already Isolated (5-Minute Fix on Resume)
1. **`src/sim/passage.ts` (`ensureFountainCounters`) — causes `tests/combat-roguelite.test.ts:792` failure**:
   - `step.ts` initializes `fountainRefillsLeft = 99` at 0BC on `createInitialSimState()`. When a test or debug command changes `state.bossStemCells = 2` afterward, `ensureFountainCounters()` skips initialization because `!== undefined`.
   - **Fix**: Clamp `state.fountainRefillsLeft = Math.min(state.fountainRefillsLeft ?? diff.fountainRefills, diff.fountainRefills)` and `state.singleFlaskRefillsLeft = Math.min(state.singleFlaskRefillsLeft ?? diff.singleFlaskRefills, diff.singleFlaskRefills)` (and initialize 2BC sandbox via `bossStemCells: 2` cleanly).
2. **`src/sim/worldgen.ts` (`ClockTower` enemy placement) — causes `ENEMY_UNGROUNDED` in `PT-069` & `PT-070`**:
   - 1 ground enemy in the new 4x6 vertical `ClockTower` layout spawns over a vertical shaft opening/void.
   - **Fix**: Guarantee every ground enemy spawn tile checks `isSolidAt(tx, floorTy) || isOneWayAt(tx, floorTy)` (via `findSafeFloorTx` AFTER all shaft/doorway carvings are finalized!).

### Exact Pre-Parity Assertions in `scripts/verify/playtest-100.ts` to Update to Authentic Parity
All other 26 failures in `playtest-100.ts` are **stale pre-parity checks** testing old behaviors we intentionally replaced with authentic Dead Cells mechanics:
- **Shield whiff CD & Hold-block (`PT-004`, `PT-027..030`)**: Whiff CD is now `36t` (PT-027 only stepped `32t` before firing the reflected bolt); hold-block activates at `shieldHoldTicks >= 16` after the parry window (PT-004/027 only held for `3t`).
- **Stuck Arrows (`PT-022..025`)**: Arrows now lodge in enemies (`enemy.stuckArrows`) and return on kill/parry/8s timeout instead of 90t passive regen.
- **Oracle 80% Rally (`PT-010`)**: Rally pool is now `80%` (not `75%`) and hit recovery is capped by `rallyLostAnchor`.
- **Weapon Crit Upgrades (`PT-012`, `PT-023`, `PT-026`)**: `QuickSword` (Balanced Blade) crits at `>= 10` `balancedStacks`; `FastBow` (Quick Bow) crits at `>= 3` `stuckArrows`; `Fireball` (Pyrotechnics) crits on `oiled` targets (not burning).
- **Cluster Grenade Bouncing Fuse (`PT-036`)**: Sub-bomblets bounce twice + 18t floor fuse — extend empty-room wait from `90t` to `150t` (and verify 5 sub-explosions!).
- **Tonic Overheal Barrier (`PT-042`)**: Tonic grants temporary `tempShieldHp` barrier + 35% DR (no infinite permanent HP heal).
- **Mutations (`PT-045/046/047/050`)**: `Melee` applies `slow` only; `Predator` grants `stealthTicks`; `Vengeance` activates for `480t` after taking damage (`lastHitTakenTick`); `BarbedTips` deals stuck-arrow DPS.
- **KingsHand Add-Summon & Sovereign Throne Walk (`PT-080..085`, `PT-090..091`)**: HoTK floats invulnerable at 85%/40% until summoned adds die (`fightBossToDeath` helper must target alive adds when `boss.invulnerable`!), and victory triggers by interacting `[F]` with the Sovereign Throne after HoTK falls.

---

## 4. Exact Resume Playbook (When User Says `"ready"`)

1. **Check & Merge `render-vfx`**:
   - Inspect `swarm-render-vfx-4acedeb1` (`git status` / `git log` / board messages > #53). If `render-vfx` committed WIP or is still verifying, let it finish or run `npm run typecheck; npm test; npm run build`, merge `--no-ff` onto `main`, and `kill` `render-vfx`.
2. **Spawn `qa-parity` Worker (`workspace: "share"`)**:
   - Fix the 2 real bugs (`src/sim/passage.ts` fountain clamp + `src/sim/worldgen.ts` `ClockTower` grounded enemy spawn).
   - Update `scripts/verify/playtest-100.ts` assertions to authentic Dead Cells parity AND add all 12 forensic parity regression tests from `PARITY_MECHANICS_BLUEPRINT.md` Section "Phase C.2" into `tests/`.
   - Merge `--no-ff` onto `main` and confirm: `npm run typecheck` (0 errors), `npm test` (100% PASS), `npm run verify:assets` (Gate A PASS), `npm run verify:sim` (Gate B PASS), `npx tsx scripts/verify/playtest-100.ts` (**100/100 PASS**, 0 Critical / 0 Major!).
3. **Restart Dev Server & Multi-Round Live Browser Visual Red-Team (Gate C)**:
   - Start `npm run play` daemon on `http://localhost:4173/`.
   - Use browser subagent (`41860794-7b1b-4e88-8711-3fac78f247fa` or fresh) to capture side-by-side screenshots in **BOTH Built-In Mode and Custom Pack Mode** across:
     1. Title Screen
     2. Prisoner's Quarters (starting pedestals/tubes, hanging jars, 12-tile autotiles, split Verlet scarf behind hero, live `head_flame` on headless hero)
     3. Active Combat (6-frame run, slash smear, splintering wood door, bouncing gibs + floor decals, arcing cells, anchored equipped-slot DPS/Crit tooltip)
     4. Biome Variety (Promenade, Toxic Sewers, Clock Tower gears, High Peak Castle `dookuCastle` scroller & stained glass)
     5. Black Bridge — Concierge (Boss Intro Splash + blazing `#ff00ff` emissive eyes/chest in Custom Pack + multi-pose Built-In + no balconies)
     6. Clock Room — Time Keeper & Throne Room — Hand of the King (multi-pose sprites, Ice Platforms, Banners, 6-Bomb Flurry)
     7. Active Curse (pulsing crimson border + overhead world Curse skull), Merchant Shop Reroll UI, and Passage (Flawless Boss Door + Legendary Forge)
   - Visually inspect EVERY screenshot via `read_file`; spawn targeted polish worker(s) and re-audit until **ZERO Critical or Major visual/feel defects remain**.
4. **Final Closeout & DNA Export**:
   - Update `HANDOFF.md`, `GAME_DNA.md`, `dna/genome.json`; run `npm run verify`, `npm run build`, `npm run export:dna` (`C:\KrunkedVault`), `npx tsx scripts/verify/playtest-100.ts`.
   - Clean all worktrees (`git worktree list` = ONLY `C:/krunked-cells`), confirm `http://localhost:4173/` live, post `[done]`, and ask user if they want `git push origin main`.
