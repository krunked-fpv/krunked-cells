# KRUNKED CELLS — Sprint Handoff

## Shipped State
Krunked Cells v1.1 (AAA Built-In Pixel Art + Dead Cells Parity Overhaul) is complete, verified across all three empirical gates and a multi-wave 100-playtester gauntlet, and synced to `C:\KrunkedVault`.

- **Architecture:** Strict TypeScript + Vite + Vitest + WebGL2 + Gothic Pixel-Art HUD + Web Audio API. Pure deterministic 60 Hz simulation (`src/sim/**`) decoupled from interpolated 30/60/120 FPS WebGL2 rendering (`src/render/**`).
- **Gameplay & Abilities Parity:** All 20 weapons (16 offense + 4 shields with parry + hold-to-block 75% DR + mouse aim), all 12 skills (including starter `InfantryGrenade` + `SinewSlicer`, forward Phantom Blink `Phaser`, floor-snapped turrets/traps, explosive VFX/SFX), 15 mutations, 18 affixes, 18 enemies + 4 Elite affixes, 10 campaign biomes + Passage safe room (Timed & 30/60 Kill-Streak doors, Collector, Guillain, Minor Forge, Health Fountain), 3 multi-phase bosses (`Behemoth` 4000 HP, `TimeKeeper` 2500 HP, `KingsHand` 5900 HP), and 0BC–5BC progression in `krunked_cells_save_v1`.
- **Dual-Mode Visual Craft Parity (Unmistakable Live Toggle):**
  - **Built-In Krunked Art:** 100% original palette-indexed RLE pixel art baked into `src/assets/builtinArtData.ts` (zero binary images in git or `dist/`) — moonlit storm-citadel title backdrop, flame-headed Prisoner poses, all 18 enemies, all 3 monumental bosses, monumental barred gothic archways, braziers, teleporters, chests, emerald fountain, Passage NPCs, and turrets, all dynamically normal-mapped (`2048×1024` Sobel heightfield + emissive masks) under 64 cel-shaded point lights + bloom.
  - **Owned Custom Pack:** Full-world Dead Cells tile/prop/2-layer scroller rendering across all 11 biomes (`258` extracted files, `37` atlases, `56/56` exact `cardIcons.png` HUD icons, `titleScreen` backdrop, `*_default_s.png` Skin LUT decoding, `headBone` tracking, `#ff00ff` chroma sanitization).
- **Authentic Dead Cells HUD & Menus:** Full-bleed Title Screen with live Art Mode switcher, sculpted clickable Glass Health Flask, beveled HP+Rally bar, crisp 48×48 pixel-icon gear slots with cooldown wipes, scroll medallions, translucent Minimap, trailing-drain Boss Bar, and zero emojis.

## Empirical Verification Proof
- **Gate A (`npm run verify:assets`):** `7/7 PASS` — `0` retail/pack/image leaks in `git ls-files` and `dist/`, `258` pack files & Oracle Parity verified.
- **100-Playtester Gauntlet (`scripts/verify/playtest-100.ts`):** Wave 0 (`77/100`) → Wave 1 (`97/100`) → Wave 2+3 (`100/100 PASSED`, Avg `100/100`, `0` Critical / `0` Major / `0` Minor).
- **Gate B (`npm test && npm run verify:sim`):** `55/55` Vitest tests pass; `21,783`-tick campaign soak clears all 8 stages, 7 Passage visits, 22 parries, and all 3 bosses (`P1->2->3`), unlocking `1BC` with bit-identical replay hash (`4c34450c === 4c34450c`).
- **Gate C (Live Browser Visual Parity — 3 Audit Rounds at `http://localhost:4173/`):** Side-by-side verified across Title, Quarters, Combat, Black Bridge, Clock Room, Throne Room, High Peak Castle, and Passage in both Built-In & Custom Pack modes; `0` console errors, `0` page errors, `0` HTTP `>= 400` responses.
