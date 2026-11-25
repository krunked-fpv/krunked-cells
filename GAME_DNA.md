# KRUNKED CELLS — Game DNA & Mashup Blueprint

**Slug:** `krunked-cells` | **Genre:** Roguelite Action-Platformer | **Sim:** Pure Deterministic 60 Hz (`FIXED_DT = 1/60`) | **Render:** 4-Pass WebGL2 Normal-Mapped Pixel Art (`480×270`, `gl.NEAREST`, 30/60/120 FPS interpolated)

---

## 1. Core / Micro / Meta Loop Architecture

- **Micro Loop (Moment-to-Moment Acrobatic Combat, 1–8 s):**
  Read enemy golden `!` windup telegraph (`14–22 ticks`) → execute instant roll-cancel (`24 ticks`, `21 iframes`, door smash `90-tick` stun) or shield parry (`16-tick` window, `100%` damage negation, `6-tick` hitstop, `75-tick` stun / `2.2×` crit projectile reflect, instant cooldown reset) → weave multi-hit weapon strike chains + status-synergy skills → recover taken damage via decaying orange Rally bar (`75%` of weapon hit damage).
- **Meso Loop (Biome Exploration & Buildcraft, 2–6 min):**
  Traverse seeded Metroidvania room graphs (`12–18` rooms, BFS reachability verified) hunting Brutality/Tactics/Survival Power Scrolls (`1.15^(stat-1)` exponential damage scaling), high-risk Cursed Chests (10-kill instant-death curse), shops, Challenge Rifts, and glowing Teleportation Runes → clear biomes under the Timed Door or 30/60 No-Hit Kill-Streak threshold.
- **Passage Safe Room Loop (Between Every Biome):**
  Unlock Timed & Kill-Streak reward doors → deposit glowing cyan Cells into The Collector for permanent blueprints → pick or respec up to 3 Guillain Mutations → upgrade item quality (`base -> + -> ++ -> S`) and reforge status-synergy affixes at the Minor Forge → refill at the Health Fountain (0BC full refill; restricted on 1BC–5BC) → choose branching next biome (`Promenade` vs `Toxic Sewers`, `Stilt Village` vs `Clock Tower`).
- **Macro / Meta Loop (Campaign & Boss Stem Cells, 15–35 min):**
  Conquer 8 campaign stages and 3 multi-phase bosses (**The Iron Concierge** `4000 HP`, **The Chrono Warden** `2500 HP`, **The Sovereign Hand** `5900 HP`) → defeat The Sovereign Hand to unlock the next Boss Stem Cell (`0BC -> 5BC`) scaling mob HP, damage, gear tier, and Cell multipliers while persisting Health Flask I–IV, Gold Reserves I–IV, Random Starter, Recycling, and weapon/skill/mutation blueprints in `krunked_cells_save_v1`.

---

## 2. Exact Game-Feel & WebGL2 Graphics Math

### 60 Hz Acrobatic Physics (`src/sim/physics.ts`, `src/sim/collision.ts`)
- **Tile Grid:** `24 px` logical tiles; Player AABB `14 × 28 px` (center-stored `pos`, feet at `pos.y + height * 0.5`).
- **Ground Run:** `155 -> 175 px/s` in 3 ticks; full stop in 2 ticks (zero drift); Kill-Streak Speed Buff `+25%`.
- **Jump & Air Control:** Initial `vy = -335 px/s`; rising gravity `980 px/s²`; falling gravity `1323 px/s²` (`1.35×`); early release cuts upward `vy × 0.48`; Double Jump `vy = -305 px/s`.
- **Forgiveness & Fluidity:** `6-tick` (`100 ms`) coyote time; `7-tick` (`117 ms`) jump buffer; `10 px` top-corner auto-mantle; `Down + Jump` instant one-way drop-through; `16-tick` Spider wall-run (`vy = -135`) + slow wall-slide (`vy <= 70`) + wall-kick (`vx = -wallDir * 195, vy = -315`).
- **Dodge Roll & Dive-Slam:** Roll `24 ticks` (`21 iframes`, `265 px/s`, `15-tick` cooldown, smashes wooden doors & stuns enemies behind them `90 ticks`). Dive-Slam `540 px/s` with invuln descent, `56 px` shockwave (`45-tick` stun), shatters `TileKind.CRACKED_FLOOR`.
- **Anti-Tunneling Swept AABB:** Separate X then Y swept tile resolution with automatic sub-stepping whenever `|v * dt| > 10 px` (verified zero tunneling at `2000–6000 px/s`).

### Combat, Parry, Rally & Scaling (`src/sim/combat.ts`, `src/sim/roguelite.ts`, `src/sim/status.ts`)
- **Defensive Cancel:** Roll or Shield Parry interrupts weapon windup AND recovery immediately with a `4-tick` input buffer.
- **Hitstop & Juice:** `2 ticks` normal hit, `4 ticks` heavy/breach, `6 ticks` crit/parry, `18-tick` boss-kill slow-mo; wall-slam bonus `+25%` damage & `35-tick` stun.
- **Rally Recovery:** `100%` of lost HP enters `rallyHp`, holds `60 ticks`, drains linearly over `240 ticks`; weapon damage heals `75%` of hit damage from `rallyHp`.
- **Scroll Curve:** `damageMult = 1.15^(stat - 1)` (Colorless / Legendary `'L'` uses `max(brutality, tactics, survival)`). Gear quality bonuses: `base: +0`, `+: +2`, `++: +4`, `S/L: +6`, scaling `1.07^(effectiveLevel - 1)`.
- **Status Synergies:** Oil + Burn (`2×` DoT + `+100%` affix), `+60%` Bleed, `+80%` Poison, `+40%` Electrocute, `+50%` Frozen/Rooted, Pierce, Toxic Explosion on kill, Flame Trail.

### 4-Pass WebGL2 Normal-Mapped Pixel-Art Pipeline (`src/render/**`, `src/assets/**`)
1. **Pass 1 — Parallax Backdrop (`480×270`, `gl.NEAREST`):** 3-stop sky gradient, twinkling stars, cratered moon + halo, drifting backlit clouds, angled moonbeam god-rays, far mountain ridges & upward gothic spires with flickering amber windows, horizon viaduct arches, rotating interlocking Clock Room gears, and optional custom scroller blending.
2. **Pass 2 — MRT G-Buffer (`Albedo` + `Normal` + `Emissive`):** Zero-allocation pre-allocated Float32Array batch renderer. 4-neighbor auto-tile bedrock silhouette interior vs exposed hand-hewn beveled edges. **Flipped-Sprite Invariant:** `if (v_flipX < 0.0) n.x = -n.x;` ensures horizontally flipped characters always catch torchlight on the true light-facing bevel.
3. **Pass 3 — Real-Time 64-Light Cel-Shaded Normal Mapping:** Directional moon rim + up to 64 flickering point lights with cubic attenuation, 3-band stylized cel ramp + grazing bevel rim, soft-knee accumulation compression (`p / (1 + 0.42 * p)`), recessed background masonry (`0.48×` light), and bright-pass emissive extract.
4. **Pass 3.5 & 4 — VFX, Volumetric Fog, Separable Bloom & ACES Composite:** Fluttering 6-node red scarf, homunculus flame wisps, sweeping weapon slashes, `!` telegraphs, biome weather (rain + splashes, acid drips, wind sparks, rotating cogs, rising embers), scrolling ground mist (`FOG_FRAG`), half-res `240×135` 9-tap separable bloom blur, ACES Filmic tone-mapping, vignette, crimson damage pulse, and golden parry ring flash.
5. **Dual-Mode Art & Dead Cells Skin LUT Decoding:** Out-of-the-box 2048×1024 procedurally baked Albedo + Sobel Tangent Normal + Emissive atlas (387 keys), plus runtime Owned Custom Pack loader parsing libGDX `.atlas`, paired `*_n.png`, `*_tracks.json` (`headBone` 3-tuple bone tracks), and `*_default_s.png` 2D palette LUTs (including `#ff00ff` emissive sentinel handling).

---

## 3. Worldgen, Enemy/Boss AI & RNG Determinism

- **PRNG (`src/sim/prng.ts`):** SplitMix32 seeding → xoshiro128** (`RngState` persisted on `SimState` every tick).
- **State Hashing (`src/sim/hash.ts`):** 32-bit FNV-1a `hashSimState(state)` proven bit-for-bit identical across 23,860-frame full-campaign replays.
- **Metroidvania Worldgen (`src/sim/worldgen.ts`):** Seeded branching room graph (Entrance, Combat Corridors/Arenas, Vertical Chain/Ladder Shafts, Treasure, Weapon/Skill/Food Shops, Cursed Chest, Challenge Rift, Teleporter Shrines, and Exit Gates for every `nextBiome`) validated via tile-space BFS (`verifyWorldReachability`) with automatic emergency bridge self-repair (100% reachable across 56+ tested seeds). Outdoor biomes carve open parallax skies; indoor biomes carve gothic cathedral windows; Clock Room carves dual circular clockwork windows.
- **Boss Phase State Machines (`src/sim/bosses.ts`):**
  - **The Iron Concierge (`Behemoth`, 4000 HP):** P1 (`100%`) Melee Punch / Ground Shockwave → P2 (`70%`) Roar Shield + Crimson Laceration Aura + Leap Slam → P3 (`35%`) Enraged rapid chains.
  - **The Chrono Warden (`TimeKeeper`, 2500 HP):** P1 Shuriken Fan / Dash Slash / Grappling Hook Pull → P2 (`65%`) Falling Swords barrage → P3 (`35%`) Accelerated multi-dash + continuous sky swords.
  - **The Sovereign Hand (`KingsHand`, 5900 HP):** P1 3-Hit Lance Combo / Shield Charge toward recessed Spike Pits / Telluric Slam → P2 (`70%`) Explosive Banners + Add-Wave invulnerable intermission → P3 (`35%`) Super-Slam shockwaves.

---

## 4. Spliceable Module Manifest & Mashup Hooks

| Module | Path | Contract Boundary | Mashup Reuse Potential |
|---|---|---|---|
| **Canonical Contracts** | `src/contracts/index.ts` | Zero-DOM shared types & constants | Drop-in Foundry contract base for any 2D action game |
| **Pure 60 Hz Sim Core** | `src/sim/{prng,hash,collision,physics,camera}.ts` | Pure `(state, input, rng, col)` | Instant Metroidvania / platform-fighter physics + replay verification |
| **Roguelite Combat & Builds** | `src/sim/{combat,status,roguelite,enemies,bosses,passage}.ts` | Pure `SimState` + `SimEvent[]` | Graft 3-color scroll scaling, parry-cancel, rally HP & curses into any brawler/ARPG |
| **BFS Room-Graph Worldgen** | `src/sim/worldgen.ts` | `TileGrid` + `RoomNode[]` + BFS verifier | Reusable guaranteed-traversable procedural dungeon generator |
| **WebGL2 Normal-Mapped Renderer** | `src/render/**` | `RendererAPI` (`init`, `render`, `ingestEvents`) | Drop-in 64-light 2D normal-mapped pixel lighting + bloom engine for any 2D game |
| **Procedural Normal Atlas & Custom Pack** | `src/assets/{ProceduralAtlas,CustomPackLoader}.ts` | `SpriteRegion` + `CustomPackAssetResolver` | Zero-asset Sobel normal-map baker + libGDX/Skin-LUT pack switcher |
| **Dual-Mode Web Audio Engine** | `src/audio/**` | `AudioEngineAPI` | Baroque-dark-synth procedural music + spatial SFX + OGG intro/loop streamer |
| **Gothic HUD, Minimap & Dev Drawer** | `src/input/**`, `src/ui/**` | `InputFrame`, `SimCommand`, `UICallbacks` | Rebindable KBM/Gamepad input, clickable teleporter minimap & live F9 telemetry drawer |

### Concrete Krunked Foundry Mashup Recipes
1. **Metroidvania × Vampire Survivors ("Krunked Horde Cells"):** Splice `src/sim/physics.ts` + `src/render/WebGL2Renderer.ts` with wave-spawner director & auto-firing skill evolutions, retaining roll-cancel, parry shockwaves, and 64-light normal-mapped arenas.
2. **Dead Cells × Tactical Card Deckbuilder ("Krunked Spire Cells"):** Keep `src/render/**` + `src/sim/combat.ts` strike chains, replacing static 2-weapon loadouts with a real-time cycling strike-card hand that triggers `SimCommand` plays and status synergies.
3. **Boss-Rush PvP / Co-Op Arena:** Reuse `src/sim/hash.ts` + `src/sim/prng.ts` + `src/sim/bosses.ts` for rollback-ready deterministic netcode boss gauntlets sharing the exact `InputFrame` tape format.

---

## 5. Player Taste Signature — Why Krunked Cells Looks & Feels Extraordinary

1. **Tactile Visual Drama:** Real-time 64-light tangent normal mapping with `n.x` flip inversion carves beveled stone masonry, fluttering crimson scarves, and boss armor out of deep cool cel-shaded shadows (`celShadow`), backed by moonlit gothic skylines, rotating clockwork gears, drifting ground fog, ACES filmic tone-mapping, and razor-sharp `gl.NEAREST` pixel-art bloom — dazzling out of the box in Built-In Art AND switching cleanly to full-color Skin-LUT-decoded Dead Cells sprites in Owned Custom Pack mode.
2. **Uncompromising Roguelite Feel:** Every weapon swing cancels instantaneously into a 21-iframe door-smashing roll or a 16-tick golden parry that freezes time for 6 ticks and resets its own cooldown; every hit recovers orange Rally HP; every biome balances timed/no-hit Passage doors, exponential `1.15^n` scroll builds, high-stakes Cursed Chests, and multi-phase boss mastery from 0BC through 5BC.
