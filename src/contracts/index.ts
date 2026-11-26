// =============================================================================
// KRUNKED CELLS — CANONICAL SPLICEABLE CONTRACTS (SINGLE SOURCE OF TRUTH)
// Zero browser/DOM/WebGL/Audio dependencies. Safe for Node headless & Browser.
// =============================================================================

export const BRAND_NAME = 'Krunked Cells' as const;
export const SLUG = 'krunked-cells' as const;
export const SAVE_KEY = 'krunked_cells_save_v1' as const;
export const SAVE_SCHEMA_VERSION = 1 as const;

export const SIM_HZ = 60 as const;
export const FIXED_DT = 1 / SIM_HZ;
export const TILE_SIZE = 24 as const;
export const VIEWPORT_W = 480 as const;
export const VIEWPORT_H = 270 as const;

export const SCROLL_DAMAGE_BASE = 1.15 as const;
export const MAX_BOSS_CELLS = 5 as const;
export const MAX_ACTIVE_LIGHTS = 64 as const;
export const PLAYER_WIDTH = 14 as const;
export const PLAYER_HEIGHT = 28 as const;

// -----------------------------------------------------------------------------
// Fundamental Identifiers & Enums
// -----------------------------------------------------------------------------

export type ScrollStat = 'brutality' | 'tactics' | 'survival';
export type ItemColor = ScrollStat | 'colorless';
export type GearQuality = 'base' | '+' | '++' | 'S' | 'L';

export type BiomeId =
  | 'PrisonStart'
  | 'PrisonCourtyard'
  | 'Sewer'
  | 'PrisonRoof'
  | 'Bridge'
  | 'StiltVillage'
  | 'ClockTower'
  | 'TopClockTower'
  | 'Castle'
  | 'Throne'
  | 'Passage';

export type BossId = 'Behemoth' | 'TimeKeeper' | 'KingsHand';

export type StatusKind =
  | 'bleed'
  | 'poison'
  | 'burn'
  | 'oil'
  | 'frost'
  | 'freeze'
  | 'root'
  | 'slow'
  | 'electrify'
  | 'stun'
  | 'speed'
  | 'shield'
  | 'corrupted';

export const TileKind = {
  EMPTY: 0,
  SOLID: 1,
  ONE_WAY: 2,
  LADDER: 3,
  CHAIN: 4,
  SPIKES: 5,
  ACID: 6,
  WATER: 7,
  CRACKED_FLOOR: 8,
  SECRET_WALL: 9,
  BG_WALL: 10,
  EXIT_GATE: 11,
} as const;
export type TileKindValue = (typeof TileKind)[keyof typeof TileKind];

export type RoomType =
  | 'entrance'
  | 'corridor'
  | 'verticalShaft'
  | 'combatArena'
  | 'treasure'
  | 'weaponShop'
  | 'skillShop'
  | 'foodShop'
  | 'cursedChest'
  | 'challengeRift'
  | 'teleporter'
  | 'exit'
  | 'bossArena'
  | 'passage';

export type PlayerActionState =
  | 'idle'
  | 'run'
  | 'jump'
  | 'fall'
  | 'wallSlide'
  | 'mantle'
  | 'roll'
  | 'diveSlam'
  | 'attack'
  | 'parry'
  | 'parrySuccess'
  | 'heal'
  | 'hurt'
  | 'dead'
  | 'resurrect';

export type EnemyActionState =
  | 'idle'
  | 'patrol'
  | 'alert'
  | 'chase'
  | 'windup'
  | 'attack'
  | 'recover'
  | 'stunned'
  | 'frozen'
  | 'rooted'
  | 'dead';

export type EliteAffix = 'laser' | 'storm' | 'twin' | 'teleport';
export type RunStatus = 'title' | 'playing' | 'passage' | 'paused' | 'dead' | 'victory';
export type ArtPackMode = 'builtin' | 'custom';
export type TargetFps = 30 | 60 | 120;
export type LightingQuality = 'low' | 'medium' | 'high';
export type BiomeWeather = 'dust' | 'rain' | 'acidDrip' | 'wind' | 'cogs' | 'embers' | 'none';

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// -----------------------------------------------------------------------------
// Pure PRNG & Collision Interfaces (for clean module splicing)
// -----------------------------------------------------------------------------

export interface RngState {
  s0: number;
  s1: number;
  s2: number;
  s3: number;
}

export interface RngAPI {
  nextU32(): number;
  nextFloat(): number;
  rangeInt(minInclusive: number, maxInclusive: number): number;
  rangeFloat(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  getState(): RngState;
}

export interface SweepResult {
  x: number;
  y: number;
  vx: number;
  vy: number;
  hitLeft: boolean;
  hitRight: boolean;
  hitCeiling: boolean;
  hitFloor: boolean;
  onOneWay: boolean;
  wallSlamSpeed: number;
  crackedFloorHit: boolean;
}

export interface CollisionAPI {
  getTile(grid: TileGrid, tx: number, ty: number): TileKindValue;
  setTile(grid: TileGrid, tx: number, ty: number, kind: TileKindValue): void;
  isSolidTile(kind: TileKindValue): boolean;
  isSolidAt(grid: TileGrid, tx: number, ty: number): boolean;
  isOneWayAt(grid: TileGrid, tx: number, ty: number): boolean;
  isClimbableAt(grid: TileGrid, tx: number, ty: number): boolean;
  isHazardAt(grid: TileGrid, tx: number, ty: number): TileKindValue | 0;
  sweepAabb(
    grid: TileGrid,
    x: number,
    y: number,
    w: number,
    h: number,
    vx: number,
    vy: number,
    dt: number,
    dropThroughOneWay: boolean,
    breakCrackedFloor: boolean
  ): SweepResult;
  hasLineOfSight(grid: TileGrid, x0: number, y0: number, x1: number, y1: number): boolean;
}

// -----------------------------------------------------------------------------
// Static Data Catalog Definitions (src/data/**)
// -----------------------------------------------------------------------------

export type WeaponKind = 'melee' | 'ranged' | 'shield';
export type CritCondition =
  | 'none'
  | 'backstab'
  | 'finalHit'
  | 'bleeding'
  | 'poisoned'
  | 'burning'
  | 'oiled'
  | 'frozenOrRooted'
  | 'speedBuff'
  | 'afterRoll'
  | 'afterParry'
  | 'isolated'
  | 'wallSlam'
  | 'highCombo'
  | 'stuckArrows3'
  | 'closeRange'
  | 'midRange'
  | 'always';

export interface StrikeStep {
  windupTicks: number;
  activeTicks: number;
  recoveryTicks: number;
  cooldownTicks: number;
  basePower: number;
  breachPower: number;
  critMul: number;
  rangeX: number;
  rangeY: number;
  offsetX: number;
  offsetY: number;
  forwardImpulse: number;
  slashColor: string;
  isRanged?: boolean;
  projectileSpeed?: number;
  projectileKind?: 'arrow' | 'knife' | 'fireball' | 'iceArrow' | 'lightning';
  pierceCount?: number;
  applyStatus?: StatusKind;
}

export interface WeaponDef {
  id: string;
  cdbId: string;
  name: string;
  description: string;
  kind: WeaponKind;
  colors: ScrollStat[];
  baseGearLevel: number;
  critCondition: CritCondition;
  strikeChain: StrikeStep[];
  parryPassive?: 'none' | 'stun' | 'bleed' | 'forcefield' | 'damageBuff';
  blockDrPct?: number;
  ammoCapacity?: number;
  unlockCost: number;
  autoUnlocked: boolean;
  spriteKey: string;
  sfxKey: string;
}

export type SkillKind = 'turret' | 'grenade' | 'power' | 'trap' | 'wave' | 'teleport';

export interface SkillDef {
  id: string;
  cdbId: string;
  name: string;
  description: string;
  kind: SkillKind;
  colors: ScrollStat[];
  cooldownTicks: number;
  basePower: number;
  radius: number;
  durationTicks: number;
  applyStatus?: StatusKind;
  secondStatus?: StatusKind;
  unlockCost: number;
  autoUnlocked: boolean;
  spriteKey: string;
  sfxKey: string;
}

export interface MutationDef {
  id: string;
  name: string;
  description: string;
  color: ItemColor;
  baseValue: number;
  scalePerStat: number;
  unlockCost: number;
  autoUnlocked: boolean;
  iconKey: string;
}

export interface AffixDef {
  id: string;
  label: string;
  kind:
    | 'bonusDmg'
    | 'applyStatus'
    | 'pierce'
    | 'explodeToxic'
    | 'flameTrail'
    | 'dmgDealtTaken'
    | 'cellBonus'
    | 'goldBonus';
  targetStatus?: StatusKind;
  multiplier?: number;
  applyStatus?: StatusKind;
  weight: number;
}

export type EnemyAttackKind =
  | 'melee'
  | 'ranged'
  | 'grenade'
  | 'shieldBash'
  | 'dash'
  | 'dive'
  | 'aoe'
  | 'hook'
  | 'auraShield'
  | 'clusterGrenade'
  | 'lungeCombo';

export interface EnemyDef {
  id: string;
  cdbId: string;
  name: string;
  baseHp: number;
  baseDamage: number;
  speed: number;
  width: number;
  height: number;
  aggroRange: number;
  attackRange: number;
  windupTicks: number;
  activeTicks: number;
  recoveryTicks: number;
  attackKind: EnemyAttackKind;
  flying: boolean;
  canBeParried: boolean;
  shieldFront: boolean;
  cellDrop: number;
  goldDrop: number;
  biomes: BiomeId[];
  spriteKey: string;
}

export interface BossPhaseDef {
  hpThreshold: number;
  name: string;
  speedMult: number;
  attacks: string[];
}

export interface BossDef {
  id: BossId;
  cdbId: string;
  name: string;
  subtitle: string;
  biomeId: BiomeId;
  baseHp: number;
  baseDamage: number;
  width: number;
  height: number;
  phases: BossPhaseDef[];
  cellReward: number;
  goldReward: number;
  spriteKey: string;
}

export interface BiomeDef {
  id: BiomeId;
  cdbId: string;
  name: string;
  stageIndex: number;
  depthTier: number;
  ambientHex: string;
  fogHex: string;
  celShadowHex: string;
  waterHex: string;
  lightColors: string[];
  weather: BiomeWeather;
  hasAcid: boolean;
  isBossArena: boolean;
  isSafeRoom: boolean;
  bossId?: BossId;
  nextBiomes: BiomeId[];
  roomCountRange: [number, number];
  scrollCount: number;
  dualScrollCount: number;
  timedDoorMinutes: number;
  killStreakDoorTarget: number;
  enemyPool: string[];
  musicKey: string;
  scrollerTheme: string;
  tilesetTheme: string;
}

export interface DifficultyDef {
  bossCells: number;
  name: string;
  mobHpMult: number;
  mobDmgMult: number;
  extraLootLevel: number;
  cellDropMult: number;
  fountainRefills: number;
  singleFlaskRefills: number;
  enemyTeleport?: boolean;
  malaiseEnabled?: boolean;
  scrollFragmentsPerBiome?: number;
}

export interface MetaBlueprintDef {
  id: string;
  name: string;
  description: string;
  category: 'upgrade' | 'weapon' | 'skill' | 'mutation';
  maxTier: number;
  costs: number[];
  targetId?: string;
}

// -----------------------------------------------------------------------------
// Simulation Runtime Entities & Master SimState
// -----------------------------------------------------------------------------

export interface StatusEffect {
  kind: StatusKind;
  ticksLeft: number;
  stacks: number;
  dps: number;
  sourceId: number;
}

export interface GearInstance {
  uid: number;
  defId: string;
  slotKind: 'weapon' | 'skill' | 'amulet';
  level: number;
  quality: GearQuality;
  color: ItemColor;
  affixes: string[];
  bonusScrolls?: Partial<Record<ScrollStat, number>>;
  dmgReductionPct?: number;
  ammo?: number;
  maxAmmo?: number;
  cooldownTicks: number;
}

export interface PlayerLoadout {
  weapon1: GearInstance | null;
  weapon2: GearInstance | null;
  skill1: GearInstance | null;
  skill2: GearInstance | null;
  amulet: GearInstance | null;
}

export interface PlayerState {
  pos: Vec2;
  prevPos: Vec2;
  vel: Vec2;
  width: number;
  height: number;
  facing: 1 | -1;
  grounded: boolean;
  onOneWay: boolean;
  onWallDir: -1 | 0 | 1;
  hp: number;
  maxHp: number;
  rallyHp: number;
  rallyHoldTicks: number;
  rallyDrainTicks: number;
  flaskCharges: number;
  maxFlaskCharges: number;
  scrolls: Record<ScrollStat, number>;
  gold: number;
  cells: number;
  killStreak: number;
  speedKillCount: number;
  speedBuffTicks: number;
  curseKillsLeft: number;
  runTimerTicks: number;
  loadout: PlayerLoadout;
  mutations: string[];
  actionState: PlayerActionState;
  actionTicks: number;
  activeWeaponSlot: 1 | 2;
  comboStep: number;
  comboResetTicks: number;
  attackPhase: 'none' | 'windup' | 'active' | 'recovery';
  attackPhaseTicks: number;
  attackHitIds: number[];
  queuedInput: 'none' | 'attack1' | 'attack2' | 'roll' | 'parry';
  queuedInputTicks: number;
  iframeTicks: number;
  rollTicks: number;
  rollCooldownTicks: number;
  afterRollCritTicks: number;
  parryWindowTicks: number;
  parryCooldownTicks: number;
  afterParryCritTicks: number;
  shieldBlocking?: boolean;
  coyoteTicks: number;
  jumpBufferTicks: number;
  airJumpsLeft: number;
  maxAirJumps: number;
  wallSlideTicks: number;
  wallRunTicksLeft: number;
  diveSlamState: 'none' | 'falling' | 'impact';
  diveStartY: number;
  healTicks: number;
  hitFlashTicks: number;
  comboMutationTicks: number;
  disengagementCooldownTicks: number;
  statusEffects: StatusEffect[];
  godMode: boolean;
  fallStartY?: number;
  fallStunTicks?: number;
  wallJumpLockTicks?: number;
  rallyLostAnchor?: number;
  onHitShieldTicks?: number;
  shieldHoldTicks?: number;
  balancedStacks?: number;
  balancedDecayTicks?: number;
  phaserBonusDamage?: number;
  phaserBuffTicks?: number;
  tempShieldHp?: number;
  tempShieldTicks?: number;
  vengeanceTicks?: number;
  stealthTicks?: number;
  wdlmCooldownTicks?: number;
  speedComboDecayTicks?: number;
  malaise?: number;
}

export interface EnemyState {
  uid: number;
  defId: string;
  name: string;
  pos: Vec2;
  prevPos: Vec2;
  vel: Vec2;
  width: number;
  height: number;
  facing: 1 | -1;
  grounded: boolean;
  hp: number;
  maxHp: number;
  damage: number;
  state: EnemyActionState;
  stateTicks: number;
  telegraphTicks: number;
  attackCooldownTicks: number;
  stunTicks: number;
  breachMeter: number;
  breachThreshold: number;
  hitFlashTicks: number;
  isElite: boolean;
  eliteAffix?: EliteAffix;
  eliteTimerTicks: number;
  isBoss: boolean;
  bossId?: BossId;
  bossPhase: number;
  bossAttackId: string;
  bossAuraTicks: number;
  bossShieldTicks: number;
  bossBannerCooldown: number;
  homePos: Vec2;
  patrolMinX: number;
  patrolMaxX: number;
  roomId: number;
  statusEffects: StatusEffect[];
  hitPlayerThisSwing: boolean;
  protectedByUid: number | null;
  turnDelayTicks?: number;
  buried?: boolean;
  teleportCooldownTicks?: number;
  stuckArrows?: Array<{ slot: 1 | 2; ttlTicks: number }>;
  ccResistStacks?: number;
  ccResistResetTicks?: number;
  bossFloatingSummon?: boolean;
  bossSubPhaseCount?: number;
  telegraphUnparriable?: boolean;
}

export interface ProjectileState {
  uid: number;
  owner: 'player' | 'enemy';
  ownerUid: number;
  kind: 'arrow' | 'knife' | 'fireball' | 'iceArrow' | 'lightning' | 'enemyBolt' | 'grenade' | 'cluster' | 'shuriken' | 'shockwave' | 'fallingSword' | 'hook' | 'laserBeam' | 'acidSpit';
  pos: Vec2;
  prevPos: Vec2;
  vel: Vec2;
  radius: number;
  damage: number;
  isCrit: boolean;
  pierceLeft: number;
  gravity: number;
  ttlTicks: number;
  maxTtlTicks: number;
  color: string;
  applyStatus?: StatusKind;
  explosionRadius?: number;
  parriable: boolean;
  hitIds: number[];
  affixes?: string[];
  piercesWalls?: boolean;
  bouncesLeft?: number;
  rollsOnFloor?: boolean;
  floorFuseTicks?: number;
  unrollable?: boolean;
  sourceWeaponSlot?: 1 | 2;
}

export interface TurretState {
  uid: number;
  defId: string;
  pos: Vec2;
  hp: number;
  maxHp: number;
  damage: number;
  range: number;
  fireCooldownTicks: number;
  ttlTicks: number;
  facing: 1 | -1;
  kind: 'sinew' | 'heavy' | 'wolfTrap' | 'bossBanner';
  owner: 'player' | 'enemy';
  rootedEnemyUid?: number | null;
}

export type PickupKind = 'gold' | 'cell' | 'food' | 'scroll' | 'dualScroll' | 'gear' | 'flaskRefill' | 'blueprint';

export interface PickupState {
  uid: number;
  kind: PickupKind;
  pos: Vec2;
  prevPos: Vec2;
  vel: Vec2;
  value: number;
  scrollChoices?: ScrollStat[];
  gear?: GearInstance;
  priceGold?: number;
  blueprintId?: string;
  label?: string;
  magnetTicks: number;
  collected: boolean;
  bobPhase: number;
  shopId?: number;
  choiceGroupId?: number;
}

export interface ChestState {
  uid: number;
  pos: Vec2;
  kind: 'treasure' | 'cursed' | 'boss';
  opened: boolean;
  roomId: number;
}

export interface DoorState {
  uid: number;
  pos: Vec2;
  width: number;
  height: number;
  kind: 'wood' | 'timed' | 'killStreak' | 'biomeExit' | 'bossGate';
  opened: boolean;
  broken: boolean;
  targetBiomeId?: BiomeId;
  label?: string;
}

export interface TeleporterState {
  uid: number;
  pos: Vec2;
  roomId: number;
  label: string;
  activated: boolean;
}

export interface ShrineState {
  uid: number;
  pos: Vec2;
  kind:
    | 'scrollAltar'
    | 'challengeRift'
    | 'fountain'
    | 'collector'
    | 'guillain'
    | 'forge'
    | 'loreSkeleton'
    | 'merchant'
    | 'recyclingTube';
  used: boolean;
  label: string;
  shopId?: number;
  shopKind?: 'weapon' | 'skill' | 'food';
  rerollCount?: number;
  colorFilter?: ScrollStat;
  tubeLoadout?: {
    weapon1: GearInstance;
    weapon2: GearInstance;
    skill1: GearInstance;
    skill2: GearInstance;
    theme: ScrollStat;
  };
}

export interface HazardState {
  uid: number;
  rect: Rect;
  kind: 'spikes' | 'acid' | 'burningOil' | 'toxicCloud' | 'shockwaveZone';
  damage: number;
  ttlTicks: number;
  owner: 'world' | 'player' | 'enemy';
}

export interface SimParticle {
  uid: number;
  pos: Vec2;
  vel: Vec2;
  size: number;
  color: string;
  alpha: number;
  ttlTicks: number;
  maxTtlTicks: number;
  gravity: number;
  emissive: boolean;
  kind: 'spark' | 'blood' | 'dust' | 'ember' | 'leaf' | 'slash' | 'ring' | 'text' | 'flame' | 'ice' | 'poison';
  text?: string;
  angle?: number;
}

export interface LightSource {
  id: number;
  x: number;
  y: number;
  radius: number;
  color: [number, number, number];
  intensity: number;
  flickerSpeed: number;
  flickerAmp: number;
  kind: 'torch' | 'brazier' | 'homunculus' | 'slash' | 'portal' | 'scroll' | 'acid' | 'boss' | 'status';
  ttlTicks?: number;
}

export interface TileGrid {
  width: number;
  height: number;
  tiles: Uint8Array;
  bgTiles: Uint8Array;
  explored: Uint8Array;
}

export interface RoomNode {
  id: number;
  type: RoomType;
  tx: number;
  ty: number;
  tw: number;
  th: number;
  neighbors: number[];
  discovered: boolean;
  cleared: boolean;
  exitBiomeId?: BiomeId;
  shopKind?: 'weapon' | 'skill' | 'food';
}

export interface CameraState {
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  targetX: number;
  targetY: number;
  shakeX: number;
  shakeY: number;
  shakeMagnitude: number;
  zoom: number;
}

export interface PassageState {
  active: boolean;
  fromBiome: BiomeId;
  nextBiomes: BiomeId[];
  timedDoorOpen: boolean;
  timedDoorClaimed: boolean;
  killStreakDoorOpen: boolean;
  killStreakDoorClaimed: boolean;
  timedTargetTicks: number;
  killStreakTarget: number;
  fountainUsed: boolean;
  activeNpc: 'none' | 'collector' | 'guillain' | 'forge';
  reforgeCount: number;
  flawlessBossDoorOpen?: boolean;
  flawlessBossDoorClaimed?: boolean;
}

export interface BossArenaState {
  active: boolean;
  bossId: BossId | null;
  bossUid: number | null;
  lockedLeftX: number;
  lockedRightX: number;
  defeated: boolean;
  bannerTicks: number;
  engaged?: boolean;
  playerTookHit?: boolean;
  icePlatformTimers?: [number, number];
}

export interface MetaSnapshot {
  bossCellsUnlocked: number;
  flaskTier: number;
  goldReserveTier: number;
  randomStarterUnlocked: boolean;
  recycleUnlocked: boolean;
  unlockedBlueprints: string[];
  blueprintProgress: Record<string, number>;
  runesUnlocked: {
    vine: boolean;
    teleport: boolean;
    ram: boolean;
    spider: boolean;
  };
  totalRuns: number;
  totalKills: number;
  bestClearTicks: number | null;
  bankedGold?: number;
  legendaryForgePlus?: number;
  legendaryForgePlusPlus?: number;
}

export interface PendingScrollPrompt {
  pickupUid: number;
  choices: ScrollStat[];
  title: string;
}

export interface RunSummary {
  victory: boolean;
  bossCells: number;
  biomeReached: BiomeId;
  kills: number;
  maxKillStreak: number;
  runTimerTicks: number;
  scrolls: Record<ScrollStat, number>;
  cellsCollected: number;
  goldCollected: number;
  causeOfDeath: string;
  unlockedNewBossCell: boolean;
}

// -----------------------------------------------------------------------------
// Simulation Events (Drained Every Tick by GameApp -> Renderer & Audio)
// -----------------------------------------------------------------------------

export type SimEvent =
  | { type: 'attackSwing'; x: number; y: number; facing: 1 | -1; weaponId: string; stepIndex: number; color: string }
  | {
      type: 'hitImpact';
      x: number;
      y: number;
      damage: number;
      breach: boolean;
      color: string;
      weaponId?: string;
      damageType?: 'blade' | 'blood' | 'fire' | 'hammer' | 'poison';
    }
  | { type: 'critImpact'; x: number; y: number; damage: number; weaponId: string }
  | { type: 'parrySuccess'; x: number; y: number; reflected: boolean }
  | { type: 'parryFail'; x: number; y: number }
  | { type: 'parryStart'; x: number; y: number; facing: 1 | -1 }
  | { type: 'shieldBlock'; x: number; y: number; reducedDamage: number }
  | { type: 'explosion'; x: number; y: number; radius: number; color: string; element: 'fire' | 'ice' | 'physical' | 'cluster' }
  | { type: 'flaskEmpty'; x: number; y: number; reason: 'empty' | 'fullHp' }
  | { type: 'dodgeRoll'; x: number; y: number; facing: 1 | -1 }
  | { type: 'diveSlamImpact'; x: number; y: number; radius: number; power: number }
  | { type: 'doorSmash'; x: number; y: number }
  | { type: 'enemyTelegraph'; x: number; y: number; enemyUid: number; unparriable?: boolean }
  | { type: 'enemyDeath'; x: number; y: number; defId: string; isElite: boolean; isBoss: boolean }
  | { type: 'bossPhaseShift'; x: number; y: number; bossId: BossId; phase: number }
  | { type: 'cellSpawn'; x: number; y: number; count: number }
  | { type: 'cellCollect'; x: number; y: number; count: number }
  | { type: 'goldCollect'; x: number; y: number; amount: number }
  | { type: 'scrollPickup'; x: number; y: number; stat: ScrollStat }
  | { type: 'itemPickup'; x: number; y: number; itemId: string }
  | { type: 'curseTriggered'; x: number; y: number; killsRequired: number }
  | { type: 'curseCleared'; x: number; y: number }
  | { type: 'flaskDrink'; x: number; y: number; healed: number }
  | { type: 'biomeTransition'; from: BiomeId; to: BiomeId }
  | { type: 'playerDamaged'; x: number; y: number; amount: number; rallyAdded: number }
  | { type: 'playerDeath'; x: number; y: number; cause: string }
  | { type: 'rallyRecovered'; x: number; y: number; amount: number }
  | { type: 'statusProc'; x: number; y: number; status: StatusKind }
  | { type: 'footstep'; x: number; y: number; surface: 'stone' | 'wood' | 'water' }
  | { type: 'jump'; x: number; y: number; isAirJump: boolean }
  | { type: 'land'; x: number; y: number; impactSpeed: number }
  | { type: 'teleport'; fromX: number; fromY: number; toX: number; toY: number }
  | { type: 'skillCast'; x: number; y: number; skillId: string }
  | { type: 'fallStun'; x: number; y: number }
  | { type: 'freezeShatter'; x: number; y: number }
  | { type: 'bleedBurst'; x: number; y: number; damage: number }
  | { type: 'lightningArc'; points: Vec2[] }
  | { type: 'bossEngage'; bossId: BossId }
  | { type: 'shopReroll'; x: number; y: number }
  | { type: 'perfectKillStreak'; count: number }
  | { type: 'perfectDodge'; x: number; y: number };

// -----------------------------------------------------------------------------
// Commands & InputFrame
// -----------------------------------------------------------------------------

export type SimCommand =
  | { type: 'pickScroll'; stat: ScrollStat }
  | { type: 'equipPickup'; pickupUid: number; targetSlot: 1 | 2 }
  | { type: 'recyclePickup'; pickupUid: number }
  | { type: 'teleportTo'; teleporterUid: number }
  | { type: 'openPassageNpc'; npc: 'none' | 'collector' | 'guillain' | 'forge' }
  | { type: 'collectorInvest'; blueprintId: string; amount: number }
  | { type: 'pickMutation'; mutationId: string; slotIndex?: number }
  | { type: 'respecMutations' }
  | { type: 'forgeUpgrade'; slot: 'weapon1' | 'weapon2' | 'skill1' | 'skill2' }
  | { type: 'forgeReforge'; slot: 'weapon1' | 'weapon2' | 'skill1' | 'skill2' }
  | { type: 'useFountain' }
  | { type: 'enterBiome'; biomeId: BiomeId }
  | { type: 'shopReroll'; shrineUid: number; preferredColor?: ScrollStat }
  | { type: 'pickRecyclingTube'; shrineUid: number }
  | { type: 'legendaryForgeInvest'; tier: 'plus' | 'plusPlus'; amount: number };

export interface InputFrame {
  moveLeft: boolean;
  moveRight: boolean;
  moveUp: boolean;
  moveDown: boolean;
  jump: boolean;
  jumpPressed: boolean;
  rollPressed: boolean;
  weapon1Pressed: boolean;
  weapon1Held: boolean;
  weapon2Pressed: boolean;
  weapon2Held: boolean;
  skill1Pressed: boolean;
  skill2Pressed: boolean;
  healPressed: boolean;
  interactPressed: boolean;
  mapTogglePressed: boolean;
  aimX?: number;
  aimY?: number;
  cameraPeekY?: number;
  commands?: SimCommand[];
}

export function createEmptyInputFrame(): InputFrame {
  return {
    moveLeft: false,
    moveRight: false,
    moveUp: false,
    moveDown: false,
    jump: false,
    jumpPressed: false,
    rollPressed: false,
    weapon1Pressed: false,
    weapon1Held: false,
    weapon2Pressed: false,
    weapon2Held: false,
    skill1Pressed: false,
    skill2Pressed: false,
    healPressed: false,
    interactPressed: false,
    mapTogglePressed: false,
  };
}

// -----------------------------------------------------------------------------
// Master Deterministic Simulation State
// -----------------------------------------------------------------------------

export interface SimState {
  tick: number;
  nextUid: number;
  rngState: RngState;
  runSeed: number;
  bossStemCells: number;
  activeBiomeId: BiomeId;
  biomesVisited: BiomeId[];
  rooms: RoomNode[];
  tileGrid: TileGrid;
  player: PlayerState;
  enemies: EnemyState[];
  projectiles: ProjectileState[];
  turrets: TurretState[];
  pickups: PickupState[];
  chests: ChestState[];
  doors: DoorState[];
  teleporters: TeleporterState[];
  shrines: ShrineState[];
  hazards: HazardState[];
  particlesSim: SimParticle[];
  lights: LightSource[];
  passageState: PassageState;
  camera: CameraState;
  hitstopTicks: number;
  slowMoTicks: number;
  screenShake: number;
  damageFlashAlpha: number;
  parryFlashAlpha: number;
  bossArenaState: BossArenaState;
  pendingScroll: PendingScrollPrompt | null;
  runStatus: RunStatus;
  runKills: number;
  maxKillStreak: number;
  totalGoldEarned: number;
  totalCellsEarned: number;
  lastDamageSource: string;
  runSummary: RunSummary | null;
  metaSnapshot: MetaSnapshot;
  events: SimEvent[];
  fountainRefillsLeft?: number;
  singleFlaskRefillsLeft?: number;
}

// -----------------------------------------------------------------------------
// Settings, Persistence, Rendering, Audio, Input, UI & DebugBridge Contracts
// -----------------------------------------------------------------------------

export interface RenderSettings {
  targetFps: TargetFps;
  snapToSimRate: boolean;
  lightingQuality: LightingQuality;
  bloomEnabled: boolean;
  screenShakeScale: number;
  artPackMode: ArtPackMode;
}

export interface AudioSettings {
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  muted: boolean;
}

export interface KeyBindings {
  moveLeft: string;
  moveRight: string;
  moveUp: string;
  moveDown: string;
  jump: string;
  roll: string;
  weapon1: string;
  weapon2: string;
  skill1: string;
  skill2: string;
  heal: string;
  interact: string;
  map: string;
  pause: string;
}

export type InputDeviceMode = 'keyboard' | 'gamepad' | 'touch';
export type GamepadVendorFamily = 'xbox' | 'playstation' | 'nintendo' | 'tesla' | 'generic';
export type GamepadLayoutPreset = 'standard' | 'classic' | 'nintendo';
export type GamepadGlyphStyle = 'auto' | 'xbox' | 'playstation' | 'nintendo';
export type TouchControlsMode = 'auto' | 'always' | 'off';

export type UiNavAction =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'confirm'
  | 'cancel'
  | 'tabPrev'
  | 'tabNext'
  | 'pause'
  | 'map';

export type VirtualControlAction =
  | 'jump'
  | 'roll'
  | 'weapon1'
  | 'weapon2'
  | 'skill1'
  | 'skill2'
  | 'heal'
  | 'interact'
  | 'map'
  | 'pause';

export interface ControllerSettings {
  deadzone: number;
  rumbleEnabled: boolean;
  rumbleIntensity: number;
  layoutPreset: GamepadLayoutPreset;
  glyphStyle: GamepadGlyphStyle;
  autoPauseOnDisconnect: boolean;
  touchMode: TouchControlsMode;
  touchOpacity: number;
  touchScale: number;
}

export interface GamepadConnectionInfo {
  connected: boolean;
  index: number;
  id: string;
  displayName: string;
  family: GamepadVendorFamily;
  mapping: string;
  isTeslaBrowser: boolean;
  hasRumble: boolean;
}

export interface ActiveInputSnapshot {
  mode: InputDeviceMode;
  touchSensed: boolean;
  touchVisible: boolean;
  isTeslaBrowser: boolean;
  gamepad: GamepadConnectionInfo | null;
  glyphFamily: 'keyboard' | GamepadVendorFamily | 'touch';
}

export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  moveLeft: 'KeyA',
  moveRight: 'KeyD',
  moveUp: 'KeyW',
  moveDown: 'KeyS',
  jump: 'Space',
  roll: 'ShiftLeft',
  weapon1: 'KeyJ',
  weapon2: 'KeyK',
  skill1: 'KeyQ',
  skill2: 'KeyE',
  heal: 'KeyR',
  interact: 'KeyF',
  map: 'Tab',
  pause: 'Escape',
};

export const DEFAULT_CONTROLLER_SETTINGS: ControllerSettings = {
  deadzone: 0.24,
  rumbleEnabled: true,
  rumbleIntensity: 0.85,
  layoutPreset: 'standard',
  glyphStyle: 'auto',
  autoPauseOnDisconnect: true,
  touchMode: 'auto',
  touchOpacity: 0.45,
  touchScale: 1.0,
};

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  targetFps: 120,
  snapToSimRate: false,
  lightingQuality: 'high',
  bloomEnabled: true,
  screenShakeScale: 1.0,
  artPackMode: 'builtin',
};

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  masterVolume: 0.75,
  musicVolume: 0.55,
  sfxVolume: 0.85,
  muted: false,
};

export interface SaveData {
  schemaVersion: number;
  meta: MetaSnapshot;
  selectedBossCells: number;
  renderSettings: RenderSettings;
  audioSettings: AudioSettings;
  keyBindings: KeyBindings;
  controllerSettings: ControllerSettings;
  hasActiveRun: boolean;
  lastSeed: number;
}

export function createDefaultMetaSnapshot(): MetaSnapshot {
  return {
    bossCellsUnlocked: 0,
    flaskTier: 1,
    goldReserveTier: 0,
    randomStarterUnlocked: false,
    recycleUnlocked: false,
    unlockedBlueprints: [
      'StartSword',
      'QuickSword',
      'DualDaggers',
      'StunMace',
      'StartShield',
      'CloseCombatBow',
      'InfantryGrenade',
      'SinewSlicer',
      'Combo',
      'Necromancy',
      'Support',
    ],
    blueprintProgress: {},
    runesUnlocked: {
      vine: true,
      teleport: true,
      ram: true,
      spider: true,
    },
    totalRuns: 0,
    totalKills: 0,
    bestClearTicks: null,
    bankedGold: 0,
    legendaryForgePlus: 0,
    legendaryForgePlusPlus: 0,
  };
}

export function createDefaultSaveData(): SaveData {
  return {
    schemaVersion: SAVE_SCHEMA_VERSION,
    meta: createDefaultMetaSnapshot(),
    selectedBossCells: 0,
    renderSettings: { ...DEFAULT_RENDER_SETTINGS },
    audioSettings: { ...DEFAULT_AUDIO_SETTINGS },
    keyBindings: { ...DEFAULT_KEY_BINDINGS },
    controllerSettings: { ...DEFAULT_CONTROLLER_SETTINGS },
    hasActiveRun: false,
    lastSeed: 133742,
  };
}

export interface PerfStats {
  fps: number;
  targetFps: TargetFps;
  simHz: number;
  frameTimeMs: number;
  drawCalls: number;
  activeLights: number;
  enemyCount: number;
  particleCount: number;
  artPackMode: ArtPackMode;
  customPackLoaded: boolean;
  stateHash: string;
}

export interface AssetManifestEntry {
  key: string;
  kind: 'atlas' | 'normal' | 'tracks' | 'scroller' | 'gradient' | 'sfx' | 'music' | 'icon';
  relPath: string;
  sizeBytes: number;
}

export interface CardIconRect {
  x: number;
  y: number;
  size: number;
}

export interface AssetManifest {
  version: number;
  extractedAt: string;
  sourceSha256: string;
  atlases: Record<string, { atlasFile: string; pages: string[]; normalPages: string[]; tracksFile?: string; skinFile?: string }>;
  scrollers: Record<string, string[]>;
  gradients: Record<string, string>;
  audioSfx: Record<string, string>;
  audioMusic: Record<string, { intro?: string; loop: string }>;
  cardIcons?: Record<string, CardIconRect>;
  entries: AssetManifestEntry[];
}

export interface CustomPackStatus {
  available: boolean;
  source: 'none' | 'devMiddleware' | 'folderPicker' | 'indexedDb';
  atlasCount: number;
  audioCount: number;
  loadedAtlases: string[];
}

export interface RendererAPI {
  init(canvas: HTMLCanvasElement, settings: RenderSettings): Promise<void>;
  resize(width: number, height: number, dpr: number): void;
  updateSettings(settings: RenderSettings): void;
  setCustomPackAvailable(pack: CustomPackStatus, loader?: CustomPackAssetResolver): void;
  render(state: SimState, interpAlpha: number, elapsedSec: number): void;
  ingestEvents(events: readonly SimEvent[], state: SimState): void;
  getDrawCallCount(): number;
  getActiveLightCount(): number;
  getBackendName(): 'webgl2' | 'canvas2d-fallback';
  dispose(): void;
}

export interface CustomPackAssetResolver {
  fetchBlob(relPath: string): Promise<Blob | null>;
  fetchText(relPath: string): Promise<string | null>;
  getManifest(): AssetManifest | null;
  getCardIconDataUrl?(itemId: string): string | null;
  getTitleBackdropDataUrl?(): string | null;
  preloadUiAssets?(): Promise<boolean>;
}

export type UiClickKind = 'select' | 'confirm' | 'cancel' | 'error' | 'ui_start' | 'ui_unlock';

export interface AudioEngineAPI {
  init(settings: AudioSettings): void;
  unlock(): Promise<void>;
  updateSettings(settings: AudioSettings): void;
  setCustomPackResolver(resolver: CustomPackAssetResolver | null, active: boolean): void;
  setBiomeMusic(biomeId: BiomeId, isBoss: boolean): void;
  setTitleMusic?(): void;
  ingestEvents(events: readonly SimEvent[], listenerX: number, listenerY: number): void;
  playUiClick(kind?: UiClickKind): void;
  dispose(): void;
}

export interface DebugBridge {
  getState(): SimState;
  getHash(): string;
  stepTicks(n: number, input?: Partial<InputFrame>): string;
  warpBiome(biomeId: BiomeId): void;
  spawnBoss(bossId: BossId): void;
  grantScrolls(brutality: number, tactics: number, survival: number): void;
  giveItem(itemId: string): void;
  setGodMode(enabled: boolean): void;
  setBossCells(bc: number): void;
  toggleArtPack(mode?: ArtPackMode): ArtPackMode;
  triggerCurse(kills?: number): void;
  resetSave(): void;
  getPerfStats(): PerfStats;
  dispatchCommand(cmd: SimCommand): void;
  startNewRun(seed?: number, bossCells?: number): void;
}

declare global {
  interface Window {
    __KRUNKED_DEBUG__?: DebugBridge;
  }
}
