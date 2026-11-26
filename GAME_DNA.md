# KRUNKED CELLS — Game DNA & Mashup Blueprint

**Slug:** `krunked-cells` | **Genre:** Roguelite Action-Platformer | **Sim:** Pure Deterministic 60 Hz (`FIXED_DT = 1/60`) | **Render:** 4-Pass WebGL2 Normal-Mapped Pixel Art (`480×270`, `gl.NEAREST`, 30/60/120 FPS interpolated)

---

## 1. Core / Micro / Meta Loop Architecture

- **Micro Loop (Moment-to-Moment Acrobatic Combat, 1–8 s):**
  Read enemy golden `!` / crimson `!!` windup telegraph (`14–22 ticks`) → execute instant roll-cancel (`24 ticks`, `21 iframes`, `42-tick` cadence with `18t` post-roll cooldown, door smash `90-tick` stun) or shield parry (`16-tick` window, `100%` damage negation, `6-tick` hitstop, `75-tick` stun / `165t` Cudgel stun / `2.2×` crit projectile reflect, `0t` instant cooldown reset vs `36t` whiff CD, `>= 16t` frontal hold-block `75%–85%` DR) → weave multi-hit weapon strike chains + status-synergy skills → recover taken damage via decaying orange Oracle Rally bar (`80%` lost HP pool, `12%` direct hit recovery capped at `20%` of `rallyLostAnchor`).
- **Meso Loop (Biome Exploration & Buildcraft, 2–6 min):**
  Traverse seeded Metroidvania room graphs (`12–18` rooms, BFS reachability verified, biome-distinct macro layouts) hunting Brutality/Tactics/Survival Power Scrolls (`1.15^(stat-1)` scaling) & `++`/`S`/`L` gear `bonusScrolls`, high-risk Cursed Chests (10-kill curse), Weapon/Skill/Food Shops (with Shop Reroll), 4-slot Recycling Tubes, Challenge Rifts, subterranean Ram cellars, and Teleportation Runes → clear biomes under the Timed Door or per-biome `30`/`60` No-Hit Kill-Streak threshold.
- **Passage Safe Room Loop (Between Every Biome):**
  Unlock Timed, Kill-Streak, & Flawless Boss reward doors → deposit glowing cyan Cells into The Collector for permanent blueprints → pick or respec up to 3 Guillain Mutations → upgrade item quality (`base -> + -> ++ -> S`), reforge status-synergy affixes, or roll Legendary Forge upgrades → refill at the Health Fountain (0BC full refill; BC-restricted on 1BC–5BC) → choose branching next biome (`Promenade` vs `Toxic Sewers`, `Stilt Village` vs `Clock Tower`).
- **Macro / Meta Loop (Campaign & Boss Stem Cells, 15–35 min):**
  Conquer 8 campaign stages and 3 multi-phase bosses (**The Iron Concierge** `4000 HP`, **The Chrono Warden** `2500 HP`, **The Sovereign Hand** `5900 HP`) → walk to and interact with the Sovereign Throne to claim victory and unlock the next Boss Stem Cell (`0BC -> 5BC`) scaling mob HP, damage, gear tier, Cell multipliers, and 5BC Malaise while persisting Health Flask I–IV, Gold Reserves I–IV, Random Starter, Recycling, and blueprints in `krunked_cells_save_v1`.

---

## 2. Exact Game-Feel & WebGL2 Graphics Math

### 60 Hz Acrobatic Physics (`src/sim/physics.ts`, `src/sim/collision.ts`)
- **Tile Grid:** `24 px` logical tiles; Player AABB `14 × 28 px` (center-stored `pos`, feet at `pos.y + height * 0.5`).
- **Ground Run:** `155 -> 175 px/s` in 3 ticks; full stop in 2 ticks (zero drift); Kill-Streak Speed Buff `+25%`.
- **Jump & Air Control:** Initial `vy = -335 px/s`; rising gravity `980 px/s²`; falling gravity `1323 px/s²` (`1.35×`); early release cuts upward `vy × 0.48`; Double Jump `vy = -305 px/s`.
- **Forgiveness & Fluidity:** `7-tick` (`117 ms`) coyote time; `7-tick` (`117 ms`) jump buffer; `20 px` effective top-corner auto-mantle; `Down + Jump` instant one-way drop-through; `16-tick` Spider wall-run (`vy = -135`) + slow wall-slide (`vy <= 70`) + wall-kick (`vx = -wallDir * 195, vy = -315`, `6-tick` away-lock); grounded vertical camera peek + fast-fall look-down.
- **Dodge Roll, High-Fall Stun & 2-Tier Dive-Slam:** Roll `24 ticks` (`21 iframes`, `265 px/s`, `42-tick` cadence = `24t` roll + `18t` post-roll cooldown, flat air-roll glide, smashes wooden doors & stuns enemies behind them `90 ticks`). Fall height `>= 132 px` triggers `36-tick` dizzy stun (roll-cancellable via `4t` buffer). Dive-Slam `540 px/s` with invuln descent, Tier 1 (`35` power / `40 px` / `30t` stun) and Tier 2 Ram Crater from `>= 72 px` (`90` power / `68 px` / `55t` stun), shatters `TileKind.CRACKED_FLOOR` into `6×3` cellars.
- **Anti-Tunneling Swept AABB:** Separate X then Y swept tile resolution with automatic sub-stepping whenever `|v * dt| > 10 px` (verified zero tunneling at `2000–6000 px/s`), plus closed-door LOS blocking.

### Combat, Parry, Rally & Scaling (`src/sim/combat.ts`, `src/sim/roguelite.ts`, `src/sim/status.ts`)
- **Defensive Cancel:** Roll or Shield Parry interrupts weapon windup AND recovery immediately with a `4-tick` input buffer.
- **Hitstop & Juice:** `2 ticks` normal hit, `4 ticks` heavy/breach, `6 ticks` crit/parry, `18-tick` boss-kill slow-mo; wall-slam bonus `+25%` damage & `35-tick` stun.
- **Oracle Rally Recovery:** `80%` of lost HP enters `rallyHp`, holds `36 ticks`, drains at `0.30 × maxHp / sec`; direct weapon/parry hits recover `12%` of hit damage capped at `20%` of `rallyLostAnchor` (reduced `-65%` during `30-tick` `0.5s` on-hit shield forcefield).
- **Boss & Status Parity:** `15%` Boss single-hit damage cap, CC diminishing returns, Freeze Shatter (`15%` burst pop), 5-stack Bleed Hemorrhage Burst, lodged Stuck Arrows returning on kill/parry/8s timeout, Tonic `tempShieldHp` barrier, and Phaser universal melee empower.
- **Scroll Curve:** `damageMult = 1.15^(stat - 1)` (Colorless / Legendary `'L'` uses `max(brutality, tactics, survival)`). Gear quality bonuses: `base: +0`, `+: +2`, `++: +4`, `S/L: +6`, scaling `1.07^(effectiveLevel - 1)` plus `++`/`S`/`L` `bonusScrolls`.
- **Status Synergies:** Oil + Burn (`2×` DoT + `+100%` affix), `+60%` Bleed, `+80%` Poison, `+40%` Electrocute, `+50%` Frozen/Rooted, Pierce, Toxic Explosion on kill, Flame Trail.

### 4-Pass WebGL2 Normal-Mapped Pixel-Art Pipeline (`src/render/**`, `src/assets/**`)
1. **Pass 1 — Parallax Backdrop (`480×270`, `gl.NEAREST`):** 8 biome-distinct procedural `PARALLAX_FRAG` styles (`u_biomeStyle` 0..7) with twinkling stars, cratered moon + halo, drifting backlit clouds, moonbeam god-rays, gothic spires, viaduct arches, interlocking Clock Room gears, plus 4-layer Custom Pack scroller support (`dookuCastle`, `ossuary`, etc.).
2. **Pass 2 — MRT G-Buffer (`Albedo` + `Normal` + `Emissive`):** Zero-allocation Float32Array batch renderer. 12-tile biome autotiling, 15 biome/shop/tube props, opaque masonry interior fill + top-trim `floorStamp` compositing, and **Flipped-Sprite Invariant:** `if (v_flipX < 0.0) n.x = -n.x;`.
3. **Pass 3 — Real-Time 64-Light Cel-Shaded Normal Mapping:** Directional moon rim + up to 64 flickering point lights with cubic attenuation, deeper cel shadows (`0.36`), relaxed point-light shoulder (`0.34`), foreground metallic `specRim`, 3-band cel ramp + grazing bevel rim, recessed background masonry, and bright-pass emissive extract.
4. **Pass 3.5 & 4 — VFX, Volumetric Fog, Bloom & ACES Composite:** Dual split Verlet scarf ribbons behind the hero, live `hero:head_flame_0..3` neck-socket mounting via `BUILTIN_HERO_HEAD_ANCHORS`, painterly weapon slash smears & chain-lightning arcs, bouncing wood splinters & gibs, 128-slot persistent floor decal ring buffer, crevice-weighted scrolling mist (`FOG_FRAG`), half-res `240×135` separable bloom blur, ACES Filmic tone-mapping, dynamic zoom punch, chromatic aberration, low-HP pulse, and active Curse vignette.
5. **Dual-Mode Art & Dead Cells Skin LUT Decoding:** Out-of-the-box `2048×2048` procedurally baked Albedo + Sobel Tangent Normal + Emissive atlas (`698` keys, `106` multi-frame original sprites, `20` painterly VFX), plus runtime Owned Custom Pack loader parsing libGDX `.atlas`, `*_n.png`, `*_tracks.json`, `*_default_s.png` 2D LUTs, and dual `{ diffuse, emissive }` extraction stripping `#ff00ff` glow sentinels across all entity/biome/FX atlases.

---

## 3. Worldgen, Enemy/Boss AI & RNG Determinism

- **PRNG (`src/sim/prng.ts`):** SplitMix32 seeding → xoshiro128** (`RngState` persisted on `SimState` every tick).
- **State Hashing (`src/sim/hash.ts`):** 32-bit FNV-1a `hashSimState(state)` proven bit-for-bit identical across `24,112`-frame full-campaign replays (`13c65986 === 13c65986`).
- **Metroidvania Worldgen (`src/sim/worldgen.ts`):** Seeded branching room graph with biome-distinct macro layouts (`PrisonCourtyard` boulevard, `Sewer` tunnels, `ClockTower` 4×6 vertical tower, `Castle` royal halls) validated via tile-space BFS (`verifyWorldReachability`) with automatic emergency bridge self-repair before grounded enemy placement (100% reachable across 56+ tested seeds).
- **Boss Phase State Machines (`src/sim/bosses.ts`):**
  - **The Iron Concierge (`Behemoth`, 4000 HP):** P1 (`100%`) Melee Punch / Shockwave / Roar Aura → P2 (`66%`) Crimson Laceration Aura + Leap Slam → P3 (`33%`) Unchained Fury rapid chains (no arena cheese balconies).
  - **The Chrono Warden (`TimeKeeper`, 2500 HP):** P1 (`100%`) Sword Combos / Shuriken Fan / Dash Slash / Grappling Hook-Pull → P2 (`70%`) Falling Swords barrage → P3 (`50%`) Accelerated multi-dash + continuous sky swords.
  - **The Sovereign Hand (`KingsHand`, 5900 HP):** P1 (`100%`) Symmetrical 3-Hit Lance Combo / 6-Bomb Flurry / Shield Charge / Jab Telluric / Banners → P2 (`85%`) Floating invulnerable Add-Summon intermission → P3 (`40%`) Second Add-Summon + Super Telluric Slam + Double Charge + destructible Ice Platforms.

---

## 4. Spliceable Module Manifest & Mashup Hooks

| Module | Path | Contract Boundary | Mashup Reuse Potential |
|---|---|---|---|
| **Canonical Contracts** | `src/contracts/index.ts` | Zero-DOM shared types & constants | Drop-in Foundry contract base for any 2D action game |
| **Pure 60 Hz Sim Core** | `src/sim/{prng,hash,collision,physics,camera}.ts` | Pure `(state, input, rng, col)` | Instant Metroidvania / platform-fighter physics + replay verification |
| **Roguelite Combat & Builds** | `src/sim/{combat,status,roguelite,enemies,bosses,passage}.ts` | Pure `SimState` + `SimEvent[]` | Graft 3-color scroll scaling, parry-cancel, rally HP & curses into any brawler/ARPG |
| **BFS Room-Graph Worldgen** | `src/sim/worldgen.ts` | `TileGrid` + `RoomNode[]` + BFS verifier | Reusable guaranteed-traversable procedural dungeon generator |
| **WebGL2 Normal-Mapped Renderer** | `src/render/**` | `RendererAPI` (`init`, `render`, `ingestEvents`) | Drop-in 64-light 2D normal-mapped pixel lighting + bloom engine for any 2D game |
| **Procedural Normal Atlas & Custom Pack** | `src/assets/{ProceduralAtlas,CustomPackLoader}.ts` | `SpriteRegion` + `CustomPackAssetResolver` | Zero-asset `2048×2048` Sobel normal-map baker + libGDX/Skin-LUT/emissive pack switcher |
| **Dual-Mode Web Audio Engine** | `src/audio/**` | `AudioEngineAPI` | Baroque-dark-synth procedural music, title theme, cell combo scale & custom WAV/OGG |
| **Gothic HUD, Minimap & Dev Drawer** | `src/input/**`, `src/ui/**` | `InputFrame`, `SimCommand`, `UICallbacks` | Anchored DPS/Crit tooltips, boss intro cards, shop/tube/forge UI & F9 dev drawer |

### Concrete Krunked Foundry Mashup Recipes
1. **Metroidvania × Vampire Survivors ("Krunked Horde Cells"):** Splice `src/sim/physics.ts` + `src/render/WebGL2Renderer.ts` with wave-spawner director & auto-firing skill evolutions, retaining roll-cancel, parry shockwaves, and 64-light normal-mapped arenas.
2. **Dead Cells × Tactical Card Deckbuilder ("Krunked Spire Cells"):** Keep `src/render/**` + `src/sim/combat.ts` strike chains, replacing static 2-weapon loadouts with a real-time cycling strike-card hand that triggers `SimCommand` plays and status synergies.
3. **Boss-Rush PvP / Co-Op Arena:** Reuse `src/sim/hash.ts` + `src/sim/prng.ts` + `src/sim/bosses.ts` for rollback-ready deterministic netcode boss gauntlets sharing the exact `InputFrame` tape format.

---

## 5. Player Taste Signature — Why Krunked Cells Looks & Feels Extraordinary

1. **Tactile Visual Drama:** Real-time 64-light tangent normal mapping (`0.36` cel shadow + `specRim`) with `n.x` flip inversion carves beveled stone masonry, split Verlet scarves, live headless flames, and boss armor out of deep atmospheric gloom, backed by 8 biome parallax styles, rotating clockwork gears, 128-slot floor decals, scrolling ground fog, ACES filmic tone-mapping, and razor-sharp `gl.NEAREST` bloom — dazzling out of the box in Built-In Art AND switching cleanly to Skin-LUT + `#ff00ff` emissive Dead Cells sprites in Owned Custom Pack mode.
2. **Uncompromising Roguelite Feel:** Every weapon swing cancels instantaneously into a 21-iframe door-smashing roll or a 16-tick golden parry that freezes time for 6 ticks, reflects projectiles at `2.2×` crit, and resets its own cooldown; every hit recovers 80% Oracle Rally HP; every biome balances timed/kill-streak/flawless Passage doors, exponential `1.15^n` scroll builds, high-stakes Cursed Chests, and multi-phase boss mastery from 0BC through 5BC Malaise.
