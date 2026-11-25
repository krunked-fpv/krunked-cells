import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUDIO_SETTINGS,
  SAVE_KEY,
  SAVE_SCHEMA_VERSION,
  createDefaultSaveData,
  createEmptyInputFrame,
  type BiomeId,
  type InputFrame,
  type SimEvent,
  type Vec2,
} from '../src/contracts';
import { SaveManager, parseSaveData, type StorageLike } from '../src/app/SaveManager';
import {
  BOSS_ARCHETYPE_IDS,
  ENEMY_ARCHETYPE_IDS,
  SKILL_ICON_IDS,
  TILESET_THEMES,
  WEAPON_ICON_IDS,
  buildProceduralAtlas,
  getAtlasKeys,
  resolveSpriteRegion,
} from '../src/assets/ProceduralAtlas';
import { AudioEngine } from '../src/audio/AudioEngine';
import { BIOME_MAP } from '../src/data';
import { collisionApi } from '../src/sim/collision';
import { hashSimState } from '../src/sim/hash';
import { enterPassageRoom, handlePassageCommand } from '../src/sim/passage';
import { createRng } from '../src/sim/prng';
import { createInitialSimState, startRunInBiome, stepSim } from '../src/sim/step';
import { generateBiomeWorld, verifyWorldReachability } from '../src/sim/worldgen';

function createMockStorage(initial: Record<string, string> = {}): StorageLike & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
}

describe('Worldgen Reachability, Passage Safe Room, SaveManager, Audio/Atlas & Replay Hash', () => {
  describe('Worldgen BFS Reachability across 56+ Seeds & All Core Biomes', () => {
    const BIOMES_TO_CHECK: readonly BiomeId[] = [
      'PrisonStart',
      'PrisonCourtyard',
      'Sewer',
      'PrisonRoof',
      'StiltVillage',
      'ClockTower',
      'Castle',
      'Passage',
    ];

    it('guarantees 100% BFS reachability to all exits, chests, shrines, teleporters, and scrolls across 56 seeds', () => {
      // 8 biomes x 7 distinct seeds = 56 generated biome worlds (plus boss arenas below)
      let verifiedWorlds = 0;

      for (let bIdx = 0; bIdx < BIOMES_TO_CHECK.length; bIdx++) {
        const biomeId = BIOMES_TO_CHECK[bIdx]!;
        for (let s = 0; s < 7; s++) {
          const seed = 10000 + bIdx * 1000 + s * 137;
          const state = createInitialSimState(seed, 0);
          const rng = createRng(seed ^ 0x5a5a5a5a);
          generateBiomeWorld(state, biomeId, rng, collisionApi);

          const targets: { label: string; pos: Vec2 }[] = [];
          for (const d of state.doors) {
            if (d.kind === 'biomeExit' || d.kind === 'timed' || d.kind === 'killStreak') {
              targets.push({ label: `door:${d.kind}:${d.uid}`, pos: d.pos });
            }
          }
          for (const c of state.chests) {
            targets.push({ label: `chest:${c.kind}:${c.uid}`, pos: c.pos });
          }
          for (const tp of state.teleporters) {
            targets.push({ label: `tp:${tp.uid}`, pos: tp.pos });
          }
          for (const sh of state.shrines) {
            targets.push({ label: `shrine:${sh.kind}:${sh.uid}`, pos: sh.pos });
          }
          for (const pk of state.pickups) {
            if (pk.kind === 'scroll' || pk.kind === 'dualScroll') {
              targets.push({ label: `scroll:${pk.uid}`, pos: pk.pos });
            }
          }

          expect(targets.length).toBeGreaterThan(0);
          const check = verifyWorldReachability(
            state.tileGrid,
            state.rooms,
            state.player.pos,
            targets
          );
          expect(check.missing, `Unreachable in ${biomeId} seed ${seed}: ${check.missing.join(', ')}`).toEqual([]);
          expect(check.reachable).toBe(true);
          verifiedWorlds++;
        }
      }

      expect(verifiedWorlds).toBeGreaterThanOrEqual(56);
    });
  });

  describe('Passage Safe Room (Doors, Collector, Guillain, Minor Forge & Fountain BC Limits)', () => {
    it('evaluates Timed Door & 30/60 Kill-Streak No-Hit Doors accurately and spawns rewards when earned', () => {
      // 1. Both Timed (<2m) and 30-Kill Streak earned after PrisonStart
      const stateEarned = createInitialSimState(5001, 0);
      const rng1 = createRng(5001);
      stateEarned.player.runTimerTicks = 60 * 60; // 1:00 < 2:00
      stateEarned.player.killStreak = 32; // >= 30
      enterPassageRoom(stateEarned, 'PrisonStart', ['PrisonCourtyard', 'Sewer'], rng1);

      expect(stateEarned.passageState.timedDoorOpen).toBe(true);
      expect(stateEarned.passageState.timedDoorClaimed).toBe(true);
      expect(stateEarned.passageState.killStreakDoorOpen).toBe(true);
      expect(stateEarned.passageState.killStreakDoorClaimed).toBe(true);
      expect(stateEarned.doors.find((d) => d.kind === 'timed')?.opened).toBe(true);
      expect(stateEarned.doors.find((d) => d.kind === 'killStreak')?.opened).toBe(true);
      // Both doors spawn gear + cells + gold rewards (3 pickups each = 6)
      expect(stateEarned.pickups.length).toBeGreaterThanOrEqual(6);

      // 2. Neither Timed nor 60-Kill Streak earned after PrisonCourtyard
      const stateMissed = createInitialSimState(5002, 0);
      const rng2 = createRng(5002);
      stateMissed.player.runTimerTicks = 10 * 60 * 60; // 10:00 > 8:00
      stateMissed.player.killStreak = 42; // < 60
      enterPassageRoom(stateMissed, 'PrisonCourtyard', ['PrisonRoof'], rng2);

      expect(stateMissed.passageState.timedDoorOpen).toBe(false);
      expect(stateMissed.passageState.killStreakDoorOpen).toBe(false);
      expect(stateMissed.doors.find((d) => d.kind === 'timed')?.opened).toBe(false);
      expect(stateMissed.doors.find((d) => d.kind === 'killStreak')?.opened).toBe(false);
      expect(stateMissed.pickups.length).toBe(0);

      // 3. 60-Kill Streak earned after PrisonCourtyard
      const state60 = createInitialSimState(5003, 0);
      const rng3 = createRng(5003);
      state60.player.runTimerTicks = 6 * 60 * 60;
      state60.player.killStreak = 60;
      enterPassageRoom(state60, 'PrisonCourtyard', ['PrisonRoof'], rng3);
      expect(state60.passageState.killStreakDoorOpen).toBe(true);
      expect(state60.passageState.timedDoorOpen).toBe(true);
    });

    it('handles Collector cell deposits & permanent blueprint unlocks (Flask, Gold Reserves, weapon, skill, mutation)', () => {
      const state = createInitialSimState(6001, 0);
      const rng = createRng(6001);
      enterPassageRoom(state, 'PrisonStart', ['PrisonCourtyard'], rng);
      state.player.cells = 500;

      // Partial deposit on Health Flask (tier 1 -> tier 2 costs 25 cells)
      expect(
        handlePassageCommand(state, { type: 'collectorInvest', blueprintId: 'health_flask', amount: 10 }, rng)
      ).toBe(true);
      expect(state.metaSnapshot.flaskTier).toBe(1);
      expect(state.metaSnapshot.blueprintProgress['health_flask']).toBe(10);

      // Complete Health Flask Tier 2 (remaining 15 cells)
      expect(
        handlePassageCommand(state, { type: 'collectorInvest', blueprintId: 'health_flask', amount: 20 }, rng)
      ).toBe(true);
      expect(state.metaSnapshot.flaskTier).toBe(2);
      expect(state.player.maxFlaskCharges).toBe(2);
      expect(state.metaSnapshot.blueprintProgress['health_flask']).toBe(0);

      // Unlock Gold Reserves Tier 1 (costs 10 cells)
      expect(
        handlePassageCommand(state, { type: 'collectorInvest', blueprintId: 'gold_reserves', amount: 10 }, rng)
      ).toBe(true);
      expect(state.metaSnapshot.goldReserveTier).toBe(1);

      // Unlock Weapon blueprint (BackStabber, costs 25 cells) -> adds to unlockedBlueprints & drops complimentary gear
      const pickupsBefore = state.pickups.length;
      expect(
        handlePassageCommand(state, { type: 'collectorInvest', blueprintId: 'bp_BackStabber', amount: 25 }, rng)
      ).toBe(true);
      expect(state.metaSnapshot.unlockedBlueprints).toContain('BackStabber');
      expect(state.pickups.length).toBe(pickupsBefore + 1);
      expect(state.pickups[state.pickups.length - 1]!.gear?.defId).toBe('BackStabber');

      // Unlock Skill blueprint (WolfTrap, costs 35 cells)
      expect(
        handlePassageCommand(state, { type: 'collectorInvest', blueprintId: 'bp_WolfTrap', amount: 50 }, rng)
      ).toBe(true);
      expect(state.metaSnapshot.unlockedBlueprints).toContain('WolfTrap');

      // Unlock Mutation blueprint (Predator, costs 30 cells)
      expect(
        handlePassageCommand(state, { type: 'collectorInvest', blueprintId: 'bp_Predator', amount: 40 }, rng)
      ).toBe(true);
      expect(state.metaSnapshot.unlockedBlueprints).toContain('Predator');

      // Verify Gold Reserves meta persists into next run starter gold
      const nextRun = createInitialSimState(6002, 0, state.metaSnapshot);
      expect(nextRun.player.gold).toBeGreaterThanOrEqual(1000);
      expect(nextRun.player.maxFlaskCharges).toBe(2);
    });

    it('handles Guillain mutation equip, slot replacement & respec, plus Minor Forge +/++/S upgrade & affix reforge', () => {
      const state = createInitialSimState(6100, 0);
      const rng = createRng(6100);
      enterPassageRoom(state, 'PrisonStart', ['PrisonCourtyard'], rng);
      state.player.gold = 20000;

      // Guillain: equip 3 mutations, reject duplicate & 4th without slotIndex, allow replacement via slotIndex
      expect(handlePassageCommand(state, { type: 'pickMutation', mutationId: 'Combo' }, rng)).toBe(true);
      expect(handlePassageCommand(state, { type: 'pickMutation', mutationId: 'Combo' }, rng)).toBe(false);
      expect(handlePassageCommand(state, { type: 'pickMutation', mutationId: 'Necromancy' }, rng)).toBe(true);
      expect(handlePassageCommand(state, { type: 'pickMutation', mutationId: 'Vengeance' }, rng)).toBe(true);
      expect(handlePassageCommand(state, { type: 'pickMutation', mutationId: 'Support' }, rng)).toBe(false);
      expect(
        handlePassageCommand(state, { type: 'pickMutation', mutationId: 'Support', slotIndex: 1 }, rng)
      ).toBe(true);
      expect(state.player.mutations).toEqual(['Combo', 'Support', 'Vengeance']);

      // Respec mutations
      const goldBeforeRespec = state.player.gold;
      expect(handlePassageCommand(state, { type: 'respecMutations' }, rng)).toBe(true);
      expect(state.player.mutations).toEqual([]);
      expect(state.player.gold).toBeLessThan(goldBeforeRespec);

      // Minor Forge: base -> + -> ++ -> S, then refuses further upgrade
      const w1 = state.player.loadout.weapon1!;
      expect(w1.quality).toBe('base');

      expect(handlePassageCommand(state, { type: 'forgeUpgrade', slot: 'weapon1' }, rng)).toBe(true);
      expect(w1.quality).toBe('+');
      expect(w1.affixes.length).toBe(2);

      expect(handlePassageCommand(state, { type: 'forgeUpgrade', slot: 'weapon1' }, rng)).toBe(true);
      expect(w1.quality).toBe('++');
      expect(w1.bonusScrolls).toBeDefined();

      expect(handlePassageCommand(state, { type: 'forgeUpgrade', slot: 'weapon1' }, rng)).toBe(true);
      expect(w1.quality).toBe('S');
      expect(w1.affixes.length).toBe(3);

      // Already S quality -> cannot upgrade further
      expect(handlePassageCommand(state, { type: 'forgeUpgrade', slot: 'weapon1' }, rng)).toBe(false);

      // Affix Reforge deducts escalating gold and re-rolls affixes
      const goldBeforeReforge = state.player.gold;
      const reforgeBefore = state.passageState.reforgeCount;
      expect(handlePassageCommand(state, { type: 'forgeReforge', slot: 'weapon1' }, rng)).toBe(true);
      expect(state.player.gold).toBeLessThan(goldBeforeReforge);
      expect(state.passageState.reforgeCount).toBe(reforgeBefore + 1);
      expect(w1.affixes.length).toBe(3);
    });

    it('enforces Health Fountain Boss Cell limits across 0BC (full), 2BC (single flask), and 4BC+ (shattered)', () => {
      // 0BC: Full HP heal + full flask refill
      const s0 = createInitialSimState(6200, 0);
      const rng0 = createRng(6200);
      s0.player.maxFlaskCharges = 3;
      s0.player.flaskCharges = 0;
      s0.player.hp = 20;
      enterPassageRoom(s0, 'PrisonStart', ['PrisonCourtyard'], rng0);
      expect(handlePassageCommand(s0, { type: 'useFountain' }, rng0)).toBe(true);
      expect(s0.player.hp).toBe(s0.player.maxHp);
      expect(s0.player.flaskCharges).toBe(3);
      // Cannot use twice in same Passage
      expect(handlePassageCommand(s0, { type: 'useFountain' }, rng0)).toBe(false);

      // 2BC: No full fountain refill, grants +30% HP & +1 single flask charge
      const s2 = createInitialSimState(6202, 2);
      const rng2 = createRng(6202);
      s2.player.maxFlaskCharges = 3;
      s2.player.flaskCharges = 0;
      s2.player.hp = 20;
      enterPassageRoom(s2, 'PrisonStart', ['PrisonCourtyard'], rng2);
      expect(handlePassageCommand(s2, { type: 'useFountain' }, rng2)).toBe(true);
      expect(s2.player.flaskCharges).toBe(1);
      expect(s2.player.hp).toBe(Math.min(s2.player.maxHp, 20 + Math.round(s2.player.maxHp * 0.3)));

      // 4BC: Shattered fountain -> disabled!
      const s4 = createInitialSimState(6204, 4);
      const rng4 = createRng(6204);
      s4.player.maxFlaskCharges = 3;
      s4.player.flaskCharges = 0;
      s4.player.hp = 20;
      enterPassageRoom(s4, 'PrisonStart', ['PrisonCourtyard'], rng4);
      expect(handlePassageCommand(s4, { type: 'useFountain' }, rng4)).toBe(false);
      expect(s4.player.hp).toBe(20);
      expect(s4.player.flaskCharges).toBe(0);
    });
  });

  describe('SaveManager Schema Validation & Corruption Recovery', () => {
    it('recovers cleanly from malformed JSON, NaNs, out-of-range boss cells/volumes, and missing fields', () => {
      const defaults = createDefaultSaveData();

      // Malformed / empty / non-object payloads
      expect(parseSaveData(null)).toEqual(defaults);
      expect(parseSaveData('')).toEqual(defaults);
      expect(parseSaveData('{corrupted json:::')).toEqual(defaults);
      expect(parseSaveData('[]')).toEqual(defaults);
      expect(parseSaveData('42')).toEqual(defaults);

      // Corrupted numeric ranges, NaNs (null in JSON), invalid enums, missing sections
      const corrupted = JSON.stringify({
        schemaVersion: 999,
        selectedBossCells: 99,
        lastSeed: -50,
        hasActiveRun: 'yes',
        meta: {
          bossCellsUnlocked: 2,
          flaskTier: -3,
          goldReserveTier: 99,
          totalRuns: -10,
          bestClearTicks: -5,
          unlockedBlueprints: ['', 123, 'BroadSword'],
          blueprintProgress: { health_flask: 15, bad: -5, nanVal: null },
        },
        renderSettings: {
          targetFps: 144,
          lightingQuality: 'ultra-raytrace',
          screenShakeScale: 999,
          artPackMode: 'pirated',
        },
        audioSettings: {
          masterVolume: 5.5,
          musicVolume: -1.2,
          sfxVolume: 'loud',
          muted: 1,
        },
        keyBindings: {
          jump: '',
          roll: 'KeyV',
        },
      });

      const sanitized = parseSaveData(corrupted);
      expect(sanitized.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
      expect(sanitized.meta.bossCellsUnlocked).toBe(2);
      expect(sanitized.selectedBossCells).toBe(2); // Clamped to unlocked BC!
      expect(sanitized.meta.flaskTier).toBe(1);
      expect(sanitized.meta.goldReserveTier).toBe(4);
      expect(sanitized.meta.totalRuns).toBe(0);
      expect(sanitized.meta.bestClearTicks).toBeNull();
      expect(sanitized.meta.unlockedBlueprints).toContain('BroadSword');
      expect(sanitized.meta.blueprintProgress).toEqual({ health_flask: 15 });
      expect(sanitized.renderSettings.targetFps).toBe(120);
      expect(sanitized.renderSettings.lightingQuality).toBe('high');
      expect(sanitized.renderSettings.screenShakeScale).toBe(2);
      expect(sanitized.renderSettings.artPackMode).toBe('builtin');
      expect(sanitized.audioSettings.masterVolume).toBe(1);
      expect(sanitized.audioSettings.musicVolume).toBe(0);
      expect(sanitized.audioSettings.sfxVolume).toBe(DEFAULT_AUDIO_SETTINGS.sfxVolume);
      expect(sanitized.audioSettings.muted).toBe(false);
      expect(sanitized.keyBindings.jump).toBe(defaults.keyBindings.jump);
      expect(sanitized.keyBindings.roll).toBe('KeyV');
      expect(sanitized.hasActiveRun).toBe(false);
      expect(sanitized.lastSeed).toBe(1);
    });

    it('round-trips valid saves through mock storage and handles throwing storage safely', () => {
      const storage = createMockStorage();
      const mgr = new SaveManager(storage);
      const snap = mgr.getSnapshot();
      snap.meta.bossCellsUnlocked = 3;
      snap.selectedBossCells = 2;
      snap.audioSettings.masterVolume = 0.4;
      mgr.save(snap);

      expect(storage.store.has(SAVE_KEY)).toBe(true);

      const mgr2 = new SaveManager(storage);
      const reloaded = mgr2.load();
      expect(reloaded.meta.bossCellsUnlocked).toBe(3);
      expect(reloaded.selectedBossCells).toBe(2);
      expect(reloaded.audioSettings.masterVolume).toBeCloseTo(0.4, 5);

      mgr2.reset();
      expect(storage.store.has(SAVE_KEY)).toBe(false);
      expect(mgr2.getSnapshot().meta.bossCellsUnlocked).toBe(0);

      // Throwing storage never throws out of SaveManager
      const brokenStorage: StorageLike = {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('quota');
        },
        removeItem: () => {
          throw new Error('denied');
        },
      };
      const safeMgr = new SaveManager(brokenStorage);
      expect(() => safeMgr.save(createDefaultSaveData())).not.toThrow();
      expect(() => safeMgr.reset()).not.toThrow();
    });
  });

  describe('AudioEngine Headless Node Safety & ProceduralAtlas Zero-DOM Coverage', () => {
    it('runs AudioEngine safely in headless Node without AudioContext or window', async () => {
      const audio = new AudioEngine();
      const sampleEvents: SimEvent[] = [
        { type: 'attackSwing', x: 100, y: 100, facing: 1, weaponId: 'StartSword', stepIndex: 0, color: '#fff' },
        { type: 'critImpact', x: 120, y: 100, damage: 120, weaponId: 'StartSword' },
        { type: 'parrySuccess', x: 100, y: 100, reflected: true },
        { type: 'bossPhaseShift', x: 200, y: 100, bossId: 'Behemoth', phase: 2 },
        { type: 'biomeTransition', from: 'PrisonStart', to: 'Bridge' },
      ];

      expect(() => audio.init(DEFAULT_AUDIO_SETTINGS)).not.toThrow();
      await expect(audio.unlock()).resolves.toBeUndefined();
      expect(() => audio.updateSettings({ ...DEFAULT_AUDIO_SETTINGS, muted: true })).not.toThrow();
      expect(() => audio.setBiomeMusic('PrisonStart', false)).not.toThrow();
      expect(() => audio.setBiomeMusic('Bridge', true)).not.toThrow();
      expect(() => audio.setCustomPackResolver(null, false)).not.toThrow();
      expect(() => audio.ingestEvents(sampleEvents, 100, 100)).not.toThrow();
      expect(() => audio.playUiClick('confirm')).not.toThrow();
      expect(() => audio.dispose()).not.toThrow();
    });

    it('provides complete zero-DOM ProceduralAtlas key coverage for all tilesets, enemies, bosses, weapons & skills', () => {
      const keys = getAtlasKeys();
      const keySet = new Set(keys);
      expect(keys.length).toBeGreaterThan(250);

      for (const theme of TILESET_THEMES) {
        expect(keySet.has(`tile:${theme}:solid_top`)).toBe(true);
        expect(keySet.has(`tile:${theme}:oneway`)).toBe(true);
        expect(keySet.has(`tile:${theme}:cracked_floor`)).toBe(true);
        expect(keySet.has(`tile:${theme}:secret_wall`)).toBe(true);
      }
      for (const enemyId of ENEMY_ARCHETYPE_IDS) {
        expect(keySet.has(`enemy:${enemyId}`)).toBe(true);
      }
      for (const bossId of BOSS_ARCHETYPE_IDS) {
        expect(keySet.has(`boss:${bossId}`)).toBe(true);
      }
      for (const weaponId of WEAPON_ICON_IDS) {
        expect(keySet.has(`weapon:${weaponId}`)).toBe(true);
      }
      for (const skillId of SKILL_ICON_IDS) {
        expect(keySet.has(`skill:${skillId}`)).toBe(true);
      }

      // Build atlas pixel buffers in headless Node (zero DOM)
      const atlas = buildProceduralAtlas();
      expect(atlas.width).toBe(2048);
      expect(atlas.height).toBe(1024);
      expect(atlas.albedoCanvas).toBeNull();
      expect(atlas.albedoPixels.byteLength).toBe(2048 * 1024 * 4);
      expect(atlas.normalPixels.byteLength).toBe(2048 * 1024 * 4);
      expect(atlas.emissivePixels.byteLength).toBe(2048 * 1024 * 4);
      expect(resolveSpriteRegion(atlas.regions, 'boss_Behemoth').w).toBeGreaterThan(0);
      expect(resolveSpriteRegion(atlas.regions, 'weapon_StartSword').w).toBeGreaterThan(0);
    });
  });

  describe('Deterministic hashSimState() Bit-For-Bit Replay Equality', () => {
    it('produces identical hashSimState() across two independent replays of identical seed + input tape', () => {
      const SEED = 987654321;
      const tape: InputFrame[] = [];
      for (let t = 0; t < 240; t++) {
        tape.push({
          ...createEmptyInputFrame(),
          moveRight: t % 60 < 40,
          moveLeft: t % 60 >= 40,
          jump: t % 35 < 10,
          jumpPressed: t % 35 === 0,
          rollPressed: t % 45 === 15,
          weapon1Pressed: t % 18 === 5,
          weapon2Pressed: t % 50 === 25,
          skill1Pressed: t === 80,
          interactPressed: t % 30 === 10,
          commands: t === 180 ? [{ type: 'enterBiome', biomeId: 'Bridge' }] : undefined,
        });
      }

      const simA = createInitialSimState(SEED, 0);
      const simB = createInitialSimState(SEED, 0);
      const hashesA: string[] = [hashSimState(simA)];
      const hashesB: string[] = [hashSimState(simB)];

      for (let t = 0; t < tape.length; t++) {
        stepSim(simA, tape[t]!);
        stepSim(simB, tape[t]!);
        hashesA.push(hashSimState(simA));
        hashesB.push(hashSimState(simB));
      }

      expect(hashesA).toEqual(hashesB);
      expect(hashesA[hashesA.length - 1]).toMatch(/^[0-9a-f]{8}$/);
      expect(simA.activeBiomeId).toBe('Bridge');

      // Divergent seed must yield a different state hash
      const simC = createInitialSimState(SEED + 1, 0);
      for (let t = 0; t < tape.length; t++) {
        stepSim(simC, tape[t]!);
      }
      expect(hashSimState(simC)).not.toBe(hashesA[hashesA.length - 1]);

      // Verify every non-passage biome has a valid entry in BIOME_MAP
      expect(Object.keys(BIOME_MAP).length).toBe(11);
      startRunInBiome(simC, 'PrisonStart');
      expect(simC.activeBiomeId).toBe('PrisonStart');
    });
  });
});
