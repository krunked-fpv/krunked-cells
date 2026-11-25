# KRUNKED CELLS — Quantitative Specification & Module Contracts

## 1. Retail Engine Recon Fingerprint (Verified Read-Only)
- Engine: Haxe + Heaps.io + HashLink (`deadcells.exe`, `libhl.dll`)
- Master Archive: `res.pak` (2,071,255,850 bytes, PAK v1, `headerSize = 238570`, `dataSize = 2071017280`, 7,055 files)
- `data.cdb`: 2,434,393 bytes JSON CastleDB (`weapon: 141`, `item: 645`, `mob: 135`, `affix: 205`, `biome: 63`, `difficulty: 6`, `hero: 2`).
- Hero Oracle (`data.cdb` `hero[0]`): `heroLife: 100`, `coyoteTime: 0.12s`, `DodgeRoll duration: 0.40s (24 ticks)`, `HealFlask power: 0.60 (60% max HP)`.

## 2. Acrobatic Movement & Swept Collision (60 Hz, 1 tile = 24 logical px)
- Player hitbox: `14 × 28 px`.
- Ground run: base speed `155 px/s`, accelerates to `175 px/s` in 3 ticks, decelerates to 0 in 2 ticks (zero drift). Speed kill-streak buff grants +25% movement speed.
- Jump: `vy = -335 px/s`, rising gravity `980 px/s²`, falling gravity `1323 px/s²` (1.35×), early jump release cuts upward `vy` by `0.48×`.
- Double jump: `vy = -305 px/s`, resets on landing or wall kick.
- Coyote time: `6 ticks` (100 ms); Jump buffer: `7 ticks` (117 ms).
- Ledge auto-mantle: jumping/falling near a 1-tile top corner within `10 px` vertical tolerance smoothly vaults onto the ledge.
- One-way platforms: solid from above; `moveDown + jumpPressed` drops through immediately.
- Spider Wall-Run & Wall-Jump: holding toward a vertical solid wall midair climbs upward (`vy = -135 px/s`) for up to `16 ticks`, then wall-slide (`vy <= 70 px/s`); pressing Jump launches away (`vx = -wallDir * 195`, `vy = -315`).
- Dodge Roll: `24 ticks` duration, `21 ticks` full iframes (`iframeTicks = 21`), `vx = facing * 265 px/s`, passes through enemies/projectiles, smashes wooden doors (stunning enemies behind them for `90 ticks`), `15 ticks` cooldown. Immediately cancels weapon windup and recovery.
- Downward Dive-Slam (`moveDown + jumpPressed` while airborne): descends at `540 px/s` with iframes; landing unleashes a `56 px` shockwave (`stun = 45 ticks`, damage scaled by fall height), breaks `TileKind.CRACKED_FLOOR`, and cancels fall recovery.
- Swept AABB Collision: separate X then Y resolution with sub-stepping whenever `|v * dt| > 10 px` — zero tunneling at any velocity.

## 3. Combat Choreography, Parry, Rally & Scroll Scaling
- **Instant Defensive Cancel**: Roll or Shield Parry cancels pre-hit windup AND post-hit recovery cleanly with `4-tick` input buffering.
- **Shield Parry**: `16-tick` active window on shield tap; parrying an enemy melee attack or parriable projectile negates 100% damage, adds `6-tick` hitstop, emits golden radial shockwave, stuns melee attacker for `75 ticks` OR reflects projectile at `2.2×` damage as a guaranteed Crit, triggers shield passive (`stun`, `bleed`, `forcefield`, `damageBuff`), and resets `parryCooldownTicks = 0`.
- **Rally (Orange Health Recovery)**: Taking damage adds 100% of lost HP to `rallyHp`, holding for `60 ticks` then draining linearly over `240 ticks`. Dealing weapon damage heals up to `75%` of damage dealt from `rallyHp`.
- **Enemy Telegraph**: Every enemy melee/ranged attack enters `windup` for `14–22 ticks` and emits `enemyTelegraph` (`!` golden flash glyph) before the active frame.
- **Hitstop**: Normal hit = `2 ticks`, heavy/breach = `4 ticks`, crit/parry = `6 ticks`, boss kill = `18 ticks` slow-mo burst. Wall slam adds bonus damage (`+25%`) and `35-tick` stun.
- **3-Color Scroll Scaling**:
  - Damage multiplier for matching stat `n`: `1.15^(n - 1)`. Colorless / Legendary (`'L'`) scales with `max(brutality, tactics, survival)`.
  - Max HP per scroll (diminishing returns):
    - Brutality: `+65%` early tapering down to `+6%`
    - Tactics: `+50%` early tapering down to `+4%`
    - Survival: `+80%` early tapering down to `+9%`
  - Gear quality level bonuses: `base: +0`, `+: +2`, `++: +4`, `S: +6`, `L: +6 (colorless)`. Effective item power scales `1.07^(effectiveLevel - 1)`.

## 4. Oracle-Calibrated Campaign, Roster & Lighting Palettes

### Biomes (10 Playable Stages + Passage Safe Room)
| BiomeId | Name | Stage | Ambient | Fog | CelShadow | Water | Weather | Next Biomes |
|---|---|---|---|---|---|---|---|---|
| `PrisonStart` | Prisoner's Quarters | 1 | `#c5c1ee` | `#062654` | `#062654` | `#363169` | `dust` | `PrisonCourtyard`, `Sewer` |
| `PrisonCourtyard` | Promenade of the Condemned | 2 | `#b6b6b6` | `#211727` | `#286d55` | `#ffd329` | `rain` | `PrisonRoof` |
| `Sewer` | Toxic Sewers | 2 | `#f67d47` | `#15290a` | `#0d4b14` | `#458e06` | `acidDrip` | `PrisonRoof` |
| `PrisonRoof` | Ramparts | 3 | `#d4a18b` | `#0e1629` | `#4f2a10` | `#363169` | `wind` | `Bridge` |
| `Bridge` | Black Bridge (Boss 1) | 4 | `#383f9a` | `#16172f` | `#2960ba` | `#448bcc` | `rain` | `StiltVillage`, `ClockTower` |
| `StiltVillage` | Stilt Village | 5 | `#e5e5e5` | `#0e332c` | `#286d55` | `#451a1a` | `rain` | `ClockTower` |
| `ClockTower` | Clock Tower | 5 | `#ae3f57` | `#540715` | `#1c3dbd` | `#38a785` | `cogs` | `TopClockTower` |
| `TopClockTower` | Clock Room (Boss 2) | 6 | `#09718e` | `#002f40` | `#1cbdb6` | `#62e1ba` | `cogs` | `Castle` |
| `Castle` | High Peak Castle | 7 | `#fbd4a8` | `#1d619f` | `#e59a71` | `#75cef6` | `embers` | `Throne` |
| `Throne` | Throne Room (Final Boss) | 8 | `#3b96ec` | `#062654` | `#2960ba` | `#448bcc` | `embers` | *(Victory)* |
| `Passage` | The Passage | 0 | `#984264` | `#33151b` | `#0e0654` | `#363169` | `dust` | *(Dynamic)* |

### Curated Full Roster
- **20 Weapons (16 Offense + 4 Shields)**:
  `StartSword` (Rusty Sword), `QuickSword` (Balanced Blade), `DualDaggers` (Twin Daggers), `BackStabber` (Assassin's Dagger), `Bleeder` (Blood Sword), `BroadSword` (Broadsword), `StunMace` (Nutcracker), `SpeedBlade` (Swift Sword), `ImpaleSpear` (Impaler), `Rapier` (Rapier), `Whip` (Electric Whip), `CloseCombatBow` (Infantry Bow), `FastBow` (Quick Bow), `FrostBow` (Ice Bow), `ThrowingKnife` (Throwing Knife), `Fireball` (Pyrotechnics), `StartShield` (Wooden Shield), `StunShield` (Cudgel), `BleedShield` (Bloodthirsty Shield), `ForceShield` (Rampart).
- **12 Skills**:
  `SinewSlicer`, `HeavyTurret`, `InfantryGrenade`, `FireGrenade`, `IceGrenade`, `ClusterGrenade`, `Phaser`, `WolfTrap`, `WaveOfDenial`, `CorruptedPower`, `KnifeDance`, `Tonic`.
- **15 Mutations**:
  `Combo`, `OpenWounds`, `Melee`, `Predator`, `Vengeance`, `Support`, `PointBlank`, `BarbedTips`, `Tranquility`, `Necromancy`, `Gastronomy`, `WhatDoesntKillMe`, `Armadillopack`, `Disengagement`, `InstinctOfTheMaster`.
- **18 Enemies** (oracle base HP):
  `Zombie` (120), `Archer` (60), `Grenader` (100), `Shield` (100), `Mage360` (100), `Runner` (160), `BatKamikaze` (15), `BatDasher` (25), `Worm` (150), `Protector` (110), `Scorpio` (100), `Comboter` (215), `Ninja` (140), `LeapingDuelyst` (230), `ClusterGrenader` (110), `PirateChief` (200), `CastleKnight` (300), `Lancer` (150).
- **3 Multi-Phase Bosses**:
  1. `Behemoth` — **The Iron Concierge** (`Bridge`, base HP 1600 scaled from oracle 4000 ratio with biome dps pacing; wait — let's expose `oracleHp: 4000` or use authentic Dead Cells HP 4000 with authentic weapon DPS ~55–180 scaled by `1.15^(scrolls-1)` so at 7–10 scrolls Concierge takes ~25–45s of thrilling combat!). Yes! Keep authentic oracle base HPs (`Behemoth: 4000`, `TimeKeeper: 2500`, `KingsHand: 5900`) and authentic weapon `basePower` (e.g. `StartSword` 32/35/50, `QuickSword` 35..60, `BroadSword` 85/120/160)! With 8 scrolls (`1.15^7 = 2.66×`) + gear level IV (`1.22×`), hits deal ~120–300 and crits ~250–600, so Concierge (4000 HP) dies in ~18–25 hits — exact Dead Cells TTK!
  2. `TimeKeeper` — **The Chrono Warden** (`TopClockTower`, base HP 2500): Shuriken Fan, Grappling Hook Pull, Dash Slash, Phase-2 Falling Swords!
  3. `KingsHand` — **The Sovereign Hand** (`Throne`, base HP 5900): 3-Hit Lance Combo, Shield Charge toward Spike Pits, Telluric Shockwave Slam, Explosive Banners, Add-Wave Intermission, Phase-3 Super-Slam!

## 5. Inter-Module Function Signatures

### `src/data/index.ts` (@gameplay)
Exports `BIOMES`, `BIOME_MAP`, `WEAPONS`, `WEAPON_MAP`, `SKILLS`, `SKILL_MAP`, `MUTATIONS`, `MUTATION_MAP`, `AFFIXES`, `AFFIX_MAP`, `ENEMIES`, `ENEMY_MAP`, `BOSSES`, `BOSS_MAP`, `DIFFICULTIES`, `META_BLUEPRINTS`, `META_BLUEPRINT_MAP`, `getDifficulty(bc)`, `getWeapon(id)`, `getSkill(id)`, `getEnemy(id)`, `getBoss(id)`, `getBiome(id)`, `getMutation(id)`, `getAffix(id)`.

### `src/sim/status.ts`, `combat.ts`, `enemies.ts`, `bosses.ts`, `roguelite.ts`, `passage.ts` (@gameplay)
All pure functions taking `(state: SimState, rng: RngAPI, col: CollisionAPI, ...)` — zero imports from `@simcore` concrete files!
- `status.ts`: `applyStatus(effects, kind, ticks, dps, sourceId)`, `hasStatus(effects, kind)`, `tickEntityStatuses(effects, onDamage, onExpire)`, `computeSynergyMultiplier(affixes, targetEffects)`
- `roguelite.ts`: `getScrollDamageMultiplier(scrolls, color)`, `computePlayerMaxHp(scrolls)`, `getQualityLevelBonus(quality)`, `computeGearDamage(basePower, gear, scrolls)`, `rollGearInstance(state, rng, slotKind, level, preferredColor?, forceLegendary?, specificDefId?)`, `applyScrollPickup(state, stat)`, `triggerCurse(state, kills)`, `onEnemyKilledForCurseAndStreak(state, rng, enemy)`, `applyMutationOnKill(state, enemy, wasMelee, wasCrit)`, `applyMutationOnParry(state)`, `applyMutationCooldownReduction(state, wasCrit)`
- `combat.ts`: `stepPlayerCombat(state, input, rng, col)`, `attemptShieldParry(state, incomingDamage, attacker, projectile, rng)`, `damagePlayer(state, amount, sourceLabel, rng, ignoreIframes?)`, `damageEnemy(state, enemy, rawDamage, isCrit, breachPower, knockbackX, knockbackY, rng, weaponId, affixes?)`, `stepProjectilesAndTurrets(state, rng, col)`, `activateSkill(state, slot, rng, col)`
- `enemies.ts`: `spawnEnemy(state, defId, x, y, roomId, rng, forceElite?)`, `stepEnemies(state, rng, col)`
- `bosses.ts`: `spawnBoss(state, bossId, x, y)`, `stepBossAI(state, boss, rng, col)`
- `passage.ts`: `enterPassageRoom(state, fromBiome, nextBiomes, rng)`, `handlePassageCommand(state, cmd, rng)`

### `src/sim/prng.ts`, `hash.ts`, `collision.ts`, `physics.ts`, `worldgen.ts`, `camera.ts`, `step.ts` (@simcore)
- `prng.ts`: `createRng(seedOrState)`, `seedToRngState(seed)`
- `hash.ts`: `hashSimState(state): string` (FNV-1a 32-bit hex string)
- `collision.ts`: `collisionApi: CollisionAPI`, plus named exports `getTile`, `setTile`, `isSolidAt`, `isOneWayAt`, `sweepAabb`, `hasLineOfSight`
- `physics.ts`: `stepPlayerPhysics(state, input, rng, col)`
- `worldgen.ts`: `generateBiomeWorld(state, biomeId, rng, col)`, `verifyWorldReachability(tileGrid, rooms, spawnPos, targets): { reachable: boolean; missing: string[] }`
- `camera.ts`: `stepCamera(state, dt)`
- `step.ts`: `createInitialSimState(seed, bossCells, meta?)`, `startRunInBiome(state, biomeId)`, `stepSim(state, input)`

## 6. WebGL2 Multi-Pass Graphics Pipeline (`src/render/**`, `src/assets/**`)
1. Logical world render target: `480 × 270` (`gl.NEAREST`), scaled cleanly to viewport canvas.
2. **Pass 1 (Parallax Backdrop)**: Sky gradient + 4–6 parallax layers (towers, gothic arches, sewer pipes, clockwork gears, drifting clouds, moonbeams) tinted by biome `ambient`, `fog`, and `celShadow`.
3. **Pass 2 (G-Buffer)**: Renders tiles, props, Hero (with animated red scarf + bone-tracked glowing homunculus flame), enemies, bosses, turrets, pickups, and luminous weapon slashes to MRT/dual FBOs (`Albedo`, `Normal`, `Emissive`). Flipped sprites (`facing === -1`) invert `normal.x = -normal.x` in the fragment shader.
4. **Pass 3 (Normal-Mapped Cel Lighting)**: Evaluates directional sky rim + up to 64 dynamic point lights (flickering braziers/torches, homunculus flame, slashes, crits, scrolls, portals, acid, status auras, boss energy) using cel-stepped Lambertian lighting blended against the biome's deep cool `celShadow` color.
5. **Pass 4 (Atmosphere, Weather & Additive Bloom)**: Scrolling procedural fog (`smokeShader`), biome weather particles (rain + splashes, embers, acid drips, wind sparks, clock cogs), bright-pass downsampled separable Gaussian bloom composited additively, vignette, and hit/parry screen tint.
6. **Procedural Built-In Art Atlas (`src/assets/ProceduralAtlas.ts`)**: Generates crisp pixel-art tilesets, characters, bosses, items, and VFX at startup with paired Sobel/bevel-shaded Tangent Normal Maps and Emissive Masks so Built-In Mode delivers rich dynamic lighting out of the box.
