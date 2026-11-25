import fs from 'node:fs';
import path from 'node:path';
import type {
  AssetManifest,
  AssetManifestEntry,
  CardIconRect,
} from '../src/contracts/index.ts';

const DEFAULT_PAK_PATH = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Dead Cells\\res.pak';
const OUT_DIR = path.resolve(process.cwd(), '.krunked-cells-assets');

interface PakFileEntry {
  path: string;
  pos: number;
  size: number;
  crc: number;
}

interface PakArchive {
  headerSize: number;
  dataSize: number;
  sourceSha256: string;
  files: Map<string, PakFileEntry>;
}

interface BatlRegion {
  name: string;
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  ox: number;
  oy: number;
  ow: number;
  oh: number;
}

interface BatlPage {
  pageName: string;
  regions: BatlRegion[];
}

function parsePakHeader(fd: number): PakArchive {
  const fixedHeader = Buffer.alloc(0x4c);
  const bytesRead = fs.readSync(fd, fixedHeader, 0, fixedHeader.length, 0);
  if (bytesRead < fixedHeader.length) {
    throw new Error('res.pak truncated before PAK v1 header');
  }

  const magic = fixedHeader.subarray(0, 3).toString('ascii');
  const version = fixedHeader[3];
  if (magic !== 'PAK' || version !== 1) {
    throw new Error(`Unsupported PAK header: magic=${JSON.stringify(magic)} ver=${version}`);
  }

  const headerSize = fixedHeader.readUInt32LE(4);
  const dataSize = fixedHeader.readUInt32LE(8);
  const sourceSha256 = fixedHeader.subarray(0x0c, 0x4c).toString('ascii');

  const headerBuf = Buffer.alloc(headerSize);
  const hdrRead = fs.readSync(fd, headerBuf, 0, headerSize, 0);
  if (hdrRead < headerSize) {
    throw new Error(`Truncated PAK directory table: expected ${headerSize}, read ${hdrRead}`);
  }

  const files = new Map<string, PakFileEntry>();
  let offset = 0x4c;

  const readNode = (prefix: string): void => {
    const nameLen = headerBuf[offset++];
    const name = headerBuf.subarray(offset, offset + nameLen).toString('utf8');
    offset += nameLen;
    const flags = headerBuf[offset++];
    const fullPath = prefix ? (name ? `${prefix}/${name}` : prefix) : name;

    if ((flags & 1) !== 0) {
      const childCount = headerBuf.readInt32LE(offset);
      offset += 4;
      for (let i = 0; i < childCount; i++) {
        readNode(fullPath);
      }
    } else {
      const pos = headerBuf.readUInt32LE(offset);
      const size = headerBuf.readUInt32LE(offset + 4);
      const crc = headerBuf.readUInt32LE(offset + 8);
      offset += 12;
      files.set(fullPath, { path: fullPath, pos, size, crc });
    }
  };

  readNode('');
  return { headerSize, dataSize, sourceSha256, files };
}

function readPakEntry(fd: number, headerSize: number, entry: PakFileEntry): Buffer {
  const buf = Buffer.allocUnsafe(entry.size);
  let totalRead = 0;
  while (totalRead < entry.size) {
    const chunk = fs.readSync(
      fd,
      buf,
      totalRead,
      entry.size - totalRead,
      headerSize + entry.pos + totalRead,
    );
    if (chunk <= 0) {
      throw new Error(`Unexpected EOF reading ${entry.path}`);
    }
    totalRead += chunk;
  }
  return buf;
}

function parseBatl(buf: Buffer): BatlPage[] | null {
  if (buf.length < 4 || buf.subarray(0, 4).toString('ascii') !== 'BATL') {
    return null;
  }

  let pos = 4;
  const pages: BatlPage[] = [];

  while (pos < buf.length) {
    const pageLen = buf[pos++];
    if (pageLen === 0) break;
    const pageName = buf.subarray(pos, pos + pageLen).toString('utf8');
    pos += pageLen;

    const regions: BatlRegion[] = [];
    while (pos < buf.length) {
      const nameLen = buf[pos++];
      if (nameLen === 0) break;
      const name = buf.subarray(pos, pos + nameLen).toString('utf8');
      pos += nameLen;

      const index = buf.readUInt16LE(pos);
      const x = buf.readUInt16LE(pos + 2);
      const y = buf.readUInt16LE(pos + 4);
      const w = buf.readUInt16LE(pos + 6);
      const h = buf.readUInt16LE(pos + 8);
      const ox = buf.readUInt16LE(pos + 10);
      const oy = buf.readUInt16LE(pos + 12);
      const ow = buf.readUInt16LE(pos + 14);
      const oh = buf.readUInt16LE(pos + 16);
      pos += 18;

      regions.push({ name, index, x, y, w, h, ox, oy, ow, oh });
    }
    pages.push({ pageName, regions });
  }

  return pages;
}

function readPngDimensions(buf: Buffer): [number, number] {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  }
  return [0, 0];
}

function serializeLibGdxAtlas(
  pages: BatlPage[],
  pageSizes: Map<string, [number, number]>,
): string {
  const lines: string[] = [];
  for (const page of pages) {
    if (lines.length > 0) {
      lines.push('');
    }
    const [pw, ph] = pageSizes.get(page.pageName) ?? [0, 0];
    lines.push(page.pageName);
    lines.push(`size: ${pw},${ph}`);
    lines.push('format: RGBA8888');
    lines.push('filter: Nearest,Nearest');
    lines.push('repeat: none');

    for (const r of page.regions) {
      // libGDX offset uses bottom-left Y offset; BATL stores top-left offset.
      const offsetY = Math.max(0, r.oh - r.h - r.oy);
      lines.push(r.name);
      lines.push('  rotate: false');
      lines.push(`  xy: ${r.x}, ${r.y}`);
      lines.push(`  size: ${r.w}, ${r.h}`);
      lines.push(`  orig: ${r.ow}, ${r.oh}`);
      lines.push(`  offset: ${r.ox}, ${offsetY}`);
      lines.push(`  index: ${r.index === 0 ? -1 : r.index}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function writeOutFile(relPath: string, data: Buffer | string): number {
  const destPath = path.join(OUT_DIR, relPath);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, data);
  return typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.length;
}

// Curated lean atlas roster: hero, 3 bosses, campaign biomes, NPCs, core enemies, core FX.
// Explicitly skips 50+ hero skin variants and cinematics to stay fast (<15s) and lean.
const CURATED_ATLASES: readonly string[] = [
  'beheaded',
  'behemoth',
  'timeKeeper',
  'HotK',
  'bridge',
  'castle',
  'clockRoom',
  'clockTower',
  'prison',
  'prisonCourtyard',
  'prisonRoof',
  'sewer',
  'cliff',
  'stiltVillage',
  'throne',
  'common',
  'collector',
  'blacksmith',
  'zombie',
  'deadArcher',
  'grenadier',
  'zombieShield',
  'mago360',
  'comboter',
  'ninja',
  'leapingDuelyst',
  'grenadierCluster',
  'pirate',
  'knight',
  'lancer',
  'zombieWorm',
  'zombieFly',
  'fxCommon',
  'fxWeapon',
  'fxEnemy',
  'ui',
  'titleScreen',
];

const CURATED_SCROLLER_GROUPS: readonly string[] = [
  'prison',
  'courtyard',
  'sewers',
  'cliff',
  'dookuCastle',
  'ossuary',
];

// Krunked Cells item/skill/mutation/HUD ID -> Dead Cells data.cdb `item` sheet ID
const CARD_ICON_CDB_MAP: Readonly<Record<string, string>> = {
  // Weapons (20)
  StartSword: 'StartSword',
  QuickSword: 'QuickSword',
  DualDaggers: 'DualDaggers',
  BackStabber: 'BackStabber',
  Bleeder: 'Bleeder',
  BroadSword: 'BroadSword',
  StunMace: 'StunMace',
  SpeedBlade: 'SpeedBlade',
  ImpaleSpear: 'ImpaleSpear',
  Rapier: 'Rapier',
  Whip: 'Whip',
  CloseCombatBow: 'CloseCombatBow',
  FastBow: 'FastBow',
  FrostBow: 'FrostBow',
  ThrowingKnife: 'ThrowingKnife',
  Fireball: 'FireBall',
  StartShield: 'StartShield',
  StunShield: 'BumpShield',
  BleedShield: 'BloodShield',
  ForceShield: 'Rampart',
  // Skills (12)
  SinewSlicer: 'StandardTurret',
  HeavyTurret: 'HeavyTurret',
  InfantryGrenade: 'FastGrenade',
  FireGrenade: 'FireBomb',
  IceGrenade: 'IceBomb',
  ClusterGrenade: 'ClusterBomb',
  Phaser: 'BackBlink',
  WolfTrap: 'RootTrap',
  WaveOfDenial: 'Shockwave',
  CorruptedPower: 'DamageBuff',
  KnifeDance: 'KnivesCircle',
  Tonic: 'ExtraHeal',
  // Mutations (15)
  Combo: 'P_DmgKill',
  OpenWounds: 'P_Bleed',
  Melee: 'P_DodgeSlow',
  Predator: 'P_InvisibilityOnKill',
  Vengeance: 'P_DmgRevenge',
  Support: 'P_DeployedDmg',
  PointBlank: 'P_DmgNearRanged',
  BarbedTips: 'P_DmgPlantedArrow',
  Tranquility: 'P_NoMobAround',
  Necromancy: 'P_HealOnKill',
  Gastronomy: 'P_Food',
  WhatDoesntKillMe: 'P_HealOnParry',
  Armadillopack: 'P_Backpack_Shield',
  Disengagement: 'P_Disengage',
  InstinctOfTheMaster: 'P_CDR_Kill',
  // Core HUD icons (9)
  HealthFlask: 'FlaskRefill',
  Cell: 'Cell',
  Gold: 'DeathMoney',
  ScrollAny: 'AnyUp',
  ScrollBrutality: 'BrutalityStuff',
  ScrollTactics: 'TacticStuff',
  ScrollSurvival: 'SurvivalStuff',
  Skull: 'P_Curse',
  BossCell: 'CellBonus',
};

interface CdbSheetLite {
  name: string;
  lines: Array<Record<string, unknown>>;
}

function extractCardIconsFromCdb(
  fd: number,
  archive: PakArchive,
): Record<string, CardIconRect> {
  const result: Record<string, CardIconRect> = {};
  const cdbEntry = archive.files.get('data.cdb');
  if (!cdbEntry) return result;

  const cdbBuf = readPakEntry(fd, archive.headerSize, cdbEntry);
  const parsed = JSON.parse(cdbBuf.toString('utf8')) as { sheets?: CdbSheetLite[] };
  const itemSheet = parsed.sheets?.find((s) => s.name === 'item');
  if (!itemSheet || !Array.isArray(itemSheet.lines)) return result;

  const byId = new Map<string, Record<string, unknown>>();
  for (const row of itemSheet.lines) {
    if (typeof row.id === 'string') {
      byId.set(row.id, row);
    }
  }

  for (const [krunkedId, cdbId] of Object.entries(CARD_ICON_CDB_MAP)) {
    const row = byId.get(cdbId);
    const icon = row?.icon as Record<string, unknown> | undefined;
    if (
      icon &&
      typeof icon.x === 'number' &&
      typeof icon.y === 'number' &&
      Number.isFinite(icon.x) &&
      Number.isFinite(icon.y)
    ) {
      const size =
        typeof icon.size === 'number' && Number.isFinite(icon.size) && icon.size > 0
          ? icon.size
          : 24;
      result[krunkedId] = { x: icon.x, y: icon.y, size };
    }
  }

  return result;
}

const CURATED_ROOT_TEXTURES: ReadonlyArray<{ key: string; pakPath: string }> = [
  { key: 'perlinNoise', pakPath: 'perlinNoise.png' },
  { key: 'smokeMask', pakPath: 'smokeMask.jpg' },
  { key: 'cardIcons', pakPath: 'cardIcons.png' },
  { key: 'mobIcons', pakPath: 'mobIcons.png' },
];

const CURATED_GRADIENTS: ReadonlyArray<{ key: string; pakPath: string }> = [
  { key: 'prisonStartMain', pakPath: 'gradients/prisonStart_L2Main.png' },
  { key: 'prisonStartFront', pakPath: 'gradients/prisonStartFrontWalls.png' },
  { key: 'prisonCourtyardMain', pakPath: 'gradients/prisonCourtyardMain.png' },
  { key: 'sewersMain', pakPath: 'gradients/sewersMain.png' },
  { key: 'roofMain', pakPath: 'gradients/roofMain.png' },
  { key: 'bridgeBg', pakPath: 'gradients/bridgeBg.png' },
  { key: 'bridgeFront', pakPath: 'gradients/bridgeFront.png' },
  { key: 'stiltVillageMain', pakPath: 'gradients/stiltVillageMain.png' },
  { key: 'clockTowerBgFar', pakPath: 'gradients/clockTowerBgFar.png' },
  { key: 'clockTowerBgFront', pakPath: 'gradients/clockTowerBgFront.png' },
  { key: 'castleMain', pakPath: 'gradients/castleMain.png' },
  { key: 'castleFrontWalls', pakPath: 'gradients/castleFrontWalls.png' },
];

// Logical SFX key -> preferred retail WAV candidates (first present in res.pak wins)
const CURATED_SFX_MAP: Record<string, readonly string[]> = {
  // Core SimEvent SFX keys
  attackSwing: ['sfx/weapon/weapon_shortsw_release.wav'],
  hitImpact: ['sfx/weapon/hit_blade.wav'],
  critImpact: ['sfx/weapon/hit_crit.wav'],
  parrySuccess: ['sfx/weapon/weapon_parryshield_release.wav', 'sfx/weapon/weapon_shield_block.wav'],
  parryFail: ['sfx/weapon/weapon_woodshield_block.wav'],
  dodgeRoll: ['sfx/hero/roll.wav'],
  diveSlamImpact: ['sfx/hero/stomp_floorbreak.wav', 'sfx/hero/stomp_char1.wav'],
  doorSmash: ['sfx/inter/door_break.wav'],
  enemyTelegraph: ['sfx/gpfeedback/lore_room_ping.wav', 'sfx/gpfeedback/perk_combo_hit.wav'],
  enemyDeath: ['sfx/enm/enm_zmb_die.wav', 'sfx/weapon/hit_flesh.wav'],
  bossPhaseShift: ['sfx/enm/enm_behemoth_shout.wav', 'sfx/gpfeedback/gong.wav'],
  cellSpawn: ['sfx/gpfeedback/jingle_elite_pop.wav'],
  cellCollect: ['sfx/inter/pick_meta.wav', 'sfx/ui/upgrade_invest.wav'],
  goldCollect: ['sfx/inter/gold_1.wav', 'sfx/weapon/drop_gold_1.wav'],
  scrollPickup: ['sfx/inter/pick_power.wav', 'sfx/ui/upgrade_new_item.wav'],
  itemPickup: ['sfx/inter/pick_weapon.wav', 'sfx/ui/upgrade_unlock.wav'],
  curseTriggered: ['sfx/gpfeedback/curse_pop.wav'],
  curseCleared: ['sfx/gpfeedback/curse_end.wav'],
  flaskDrink: ['sfx/hero/use_potion.wav'],
  biomeTransition: ['sfx/inter/door_open.wav', 'sfx/gpfeedback/gong.wav'],
  playerDamaged: ['sfx/hero/hero_dmg1.wav'],
  playerDeath: ['sfx/hero/hero_die.wav'],
  rallyRecovered: ['sfx/gpfeedback/damned_vigor_success.wav'],
  statusProc: ['sfx/weapon/hit_blood_stack.wav'],
  footstep: ['sfx/hero/step1.wav'],
  footstepWood: ['sfx/hero/step_wood1.wav'],
  footstepWater: ['sfx/hero/step_water1.wav'],
  jump: ['sfx/hero/jump.wav'],
  airJump: ['sfx/hero/jump2.wav'],
  land: ['sfx/hero/land.wav'],
  teleport: ['sfx/inter/rune_tp_rub.wav', 'sfx/gpfeedback/malaise_tp.wav'],
  skillCast: ['sfx/active/active_grenade_throw.wav', 'sfx/weapon/magic_cast1.wav'],

  // Weapon-specific SFX keys
  sword: ['sfx/weapon/weapon_shortsw_release.wav'],
  broadsword: ['sfx/weapon/weapon_broadsword_release1.wav'],
  dagger: ['sfx/weapon/weapon_cupiddagger_release1.wav', 'sfx/weapon/weapon_shortsw_release.wav'],
  mace: ['sfx/weapon/weapon_stunmace_release1.wav'],
  spear: ['sfx/weapon/weapon_throwingspear_release.wav'],
  rapier: ['sfx/weapon/weapon_rapier_release.wav'],
  whip: ['sfx/weapon/weapon_electricwhip_release1.wav', 'sfx/weapon/weapon_whip_release.wav'],
  bow: ['sfx/weapon/bow_shot1.wav'],
  iceBow: ['sfx/weapon/bow_shot_ice.wav'],
  knife: ['sfx/weapon/weapon_throwablestuff_release01.wav'],
  fireball: ['sfx/weapon/weapon_fireball_release1.wav', 'sfx/weapon/fire_spell1.wav'],
  shield: ['sfx/weapon/weapon_shield_block.wav'],
  hitBlade: ['sfx/weapon/hit_blade.wav'],
  hitBlood: ['sfx/weapon/hit_blood.wav'],
  hitFire: ['sfx/weapon/hit_fire.wav'],
  hitHammer: ['sfx/weapon/hit_hammer.wav'],
  hitPoison: ['sfx/weapon/hit_poison.wav'],

  // Skill & feedback cues
  grenadeExplode: ['sfx/active/active_grenade_explo.wav'],
  grenadeFire: ['sfx/active/active_grenade_fire.wav'],
  grenadeIce: ['sfx/active/active_grenade_ice.wav'],
  turretDeploy: ['sfx/active/active_ceillingturret_deploy.wav'],
  waveOfDenial: ['sfx/active/active_denialwave.wav'],
  bossVictory: ['sfx/gpfeedback/jingle_boss_win.wav'],
  perfectKillStreak: ['sfx/gpfeedback/perfectKillsStep.wav'],
  perfectDodge: ['sfx/gpfeedback/perk_perfectdodge.wav'],

  // UI cues (both short and prefixed forms)
  select: ['sfx/ui/menu_select.wav'],
  confirm: ['sfx/ui/menu_click1.wav'],
  cancel: ['sfx/ui/menu_back.wav'],
  error: ['sfx/ui/menu_error.wav'],
  ui_select: ['sfx/ui/menu_select.wav'],
  ui_confirm: ['sfx/ui/menu_click1.wav'],
  ui_cancel: ['sfx/ui/menu_back.wav'],
  ui_error: ['sfx/ui/menu_error.wav'],
  ui_start: ['sfx/ui/menu_start.wav'],
  ui_unlock: ['sfx/ui/jingle_unlock.wav'],
};

const CURATED_MUSIC_MAP: Record<string, { intro?: string; loop: string }> = {
  title: {
    intro: 'music/default/Prologue_intro.ogg',
    loop: 'music/default/Prologue_loop.ogg',
  },
  PrisonStart: {
    intro: 'music/default/prisonstart_intro.ogg',
    loop: 'music/default/prisonstart_loop.ogg',
  },
  PrisonCourtyard: { loop: 'music/default/Promenade.ogg' },
  Sewer: { loop: 'music/default/Sewers.ogg' },
  PrisonRoof: {
    intro: 'music/default/music4_intro.ogg',
    loop: 'music/default/music4_loop.ogg',
  },
  Bridge: { loop: 'music/default/Bridge.ogg' },
  StiltVillage: { loop: 'music/default/Village.ogg' },
  ClockTower: { loop: 'music/default/clocktower.ogg' },
  TopClockTower: { loop: 'music/default/assassin.ogg' },
  Castle: {
    intro: 'music/default/castle_intro.ogg',
    loop: 'music/default/castle_loop.ogg',
  },
  Throne: { loop: 'music/default/throne.ogg' },
  Passage: { loop: 'music/default/shop_loop1.ogg' },
  ambient: { loop: 'music/default/ambiant1.ogg' },
};

function main(): void {
  const startMs = Date.now();
  const pakPath = process.env.DEAD_CELLS_PAK || DEFAULT_PAK_PATH;

  if (!fs.existsSync(pakPath)) {
    console.log(
      `[extract-assets] Retail res.pak not found at "${pakPath}". Skipping extraction (Built-In Art Mode works without retail files).`,
    );
    process.exit(0);
  }

  console.log(`[extract-assets] Opening read-only: ${pakPath}`);
  const fd = fs.openSync(pakPath, 'r');

  try {
    const archive = parsePakHeader(fd);
    console.log(
      `[extract-assets] PAK v1 verified: ${archive.files.size} files, sha256=${archive.sourceSha256.slice(0, 16)}...`,
    );

    fs.mkdirSync(OUT_DIR, { recursive: true });

    const writtenByRelPath = new Map<string, AssetManifestEntry>();
    const recordEntry = (
      key: string,
      kind: AssetManifestEntry['kind'],
      relPath: string,
      sizeBytes: number,
    ): void => {
      if (!writtenByRelPath.has(relPath)) {
        writtenByRelPath.set(relPath, { key, kind, relPath, sizeBytes });
      }
    };

    const extractRaw = (
      pakRelPath: string,
      key: string,
      kind: AssetManifestEntry['kind'],
    ): Buffer | null => {
      const entry = archive.files.get(pakRelPath);
      if (!entry) return null;
      const existing = writtenByRelPath.get(pakRelPath);
      if (existing) {
        return readPakEntry(fd, archive.headerSize, entry);
      }
      const buf = readPakEntry(fd, archive.headerSize, entry);
      const sizeBytes = writeOutFile(pakRelPath, buf);
      recordEntry(key, kind, pakRelPath, sizeBytes);
      return buf;
    };

    const atlases: AssetManifest['atlases'] = {};
    const scrollers: AssetManifest['scrollers'] = {};
    const gradients: AssetManifest['gradients'] = {};
    const audioSfx: AssetManifest['audioSfx'] = {};
    const audioMusic: AssetManifest['audioMusic'] = {};

    // 1. Curated core atlases (.atlas converted BATL -> libGDX text, pages, paired _n.png, _tracks.json)
    for (const atlasName of CURATED_ATLASES) {
      const atlasPakPath = `atlas/${atlasName}.atlas`;
      const atlasEntry = archive.files.get(atlasPakPath);
      if (!atlasEntry) continue;

      const rawAtlasBuf = readPakEntry(fd, archive.headerSize, atlasEntry);
      const batlPages = parseBatl(rawAtlasBuf);
      const pages: string[] = [];
      const normalPages: string[] = [];
      const pageSizes = new Map<string, [number, number]>();

      const candidatePageNames: string[] = batlPages
        ? batlPages.map((p) => p.pageName)
        : [`${atlasName}0.png`, `${atlasName}.png`];

      for (const pageFileName of candidatePageNames) {
        const pagePakPath = `atlas/${pageFileName}`;
        const pageEntry = archive.files.get(pagePakPath);
        if (!pageEntry) continue;

        const pageBuf = readPakEntry(fd, archive.headerSize, pageEntry);
        const pageBytes = writeOutFile(pagePakPath, pageBuf);
        recordEntry(`${atlasName}:${pageFileName}`, 'atlas', pagePakPath, pageBytes);
        pages.push(pagePakPath);
        pageSizes.set(pageFileName, readPngDimensions(pageBuf));

        const normalFileName = pageFileName.replace(/\.png$/i, '_n.png');
        const normalPakPath = `atlas/${normalFileName}`;
        if (archive.files.has(normalPakPath)) {
          const nBuf = extractRaw(normalPakPath, `${atlasName}:${normalFileName}`, 'normal');
          if (nBuf) {
            normalPages.push(normalPakPath);
          }
        }
      }

      if (pages.length === 0) continue;

      const atlasText = batlPages
        ? serializeLibGdxAtlas(batlPages, pageSizes)
        : rawAtlasBuf.toString('utf8');
      const atlasBytes = writeOutFile(atlasPakPath, atlasText);
      recordEntry(atlasName, 'atlas', atlasPakPath, atlasBytes);

      let tracksFile: string | undefined;
      const tracksPakPath = `atlas/${atlasName}_tracks.json`;
      if (archive.files.has(tracksPakPath)) {
        extractRaw(tracksPakPath, `${atlasName}_tracks`, 'tracks');
        tracksFile = tracksPakPath;
      }

      let skinFile: string | undefined;
      const skinPakPath = `atlas/${atlasName}_default_s.png`;
      if (archive.files.has(skinPakPath)) {
        extractRaw(skinPakPath, `${atlasName}_default_s`, 'atlas');
        skinFile = skinPakPath;
      }

      atlases[atlasName] = {
        atlasFile: atlasPakPath,
        pages,
        normalPages,
        ...(tracksFile ? { tracksFile } : {}),
        ...(skinFile ? { skinFile } : {}),
      };
    }

    // 2. Core parallax scrollers
    for (const group of CURATED_SCROLLER_GROUPS) {
      const prefix = `scroller/${group}/`;
      const groupPaths = Array.from(archive.files.keys())
        .filter((p) => p.startsWith(prefix))
        .sort();
      const extractedGroup: string[] = [];

      for (const relPath of groupPaths) {
        const buf = extractRaw(relPath, `scroller:${group}:${path.posix.basename(relPath)}`, 'scroller');
        if (buf) {
          extractedGroup.push(relPath);
        }
      }
      if (extractedGroup.length > 0) {
        scrollers[group] = extractedGroup;
      }
    }

    // 3. Core noise, smoke mask, cardIcons & mobIcons
    for (const item of CURATED_ROOT_TEXTURES) {
      extractRaw(item.pakPath, item.key, 'icon');
    }

    // 4. Up to 12 biome gradients
    for (const grad of CURATED_GRADIENTS.slice(0, 12)) {
      if (archive.files.has(grad.pakPath)) {
        extractRaw(grad.pakPath, grad.key, 'gradient');
        gradients[grad.key] = grad.pakPath;
      }
    }

    // 5. Curated gameplay SFX mapped to logical keys
    for (const [sfxKey, candidates] of Object.entries(CURATED_SFX_MAP)) {
      for (const candidate of candidates) {
        if (archive.files.has(candidate)) {
          if (!writtenByRelPath.has(candidate)) {
            extractRaw(candidate, sfxKey, 'sfx');
          }
          audioSfx[sfxKey] = candidate;
          break;
        }
      }
    }

    // 6. Core music tracks (intro + loop pairs where present)
    for (const [musicKey, spec] of Object.entries(CURATED_MUSIC_MAP)) {
      if (!archive.files.has(spec.loop)) continue;
      if (!writtenByRelPath.has(spec.loop)) {
        extractRaw(spec.loop, `${musicKey}_loop`, 'music');
      }

      let introRel: string | undefined;
      if (spec.intro && archive.files.has(spec.intro)) {
        if (!writtenByRelPath.has(spec.intro)) {
          extractRaw(spec.intro, `${musicKey}_intro`, 'music');
        }
        introRel = spec.intro;
      }

      audioMusic[musicKey] = {
        ...(introRel ? { intro: introRel } : {}),
        loop: spec.loop,
      };
    }

    // 7. Parse data.cdb (`item` sheet) for exact cardIcons.png sprite coordinates
    const cardIcons = extractCardIconsFromCdb(fd, archive);

    const entries = Array.from(writtenByRelPath.values()).sort((a, b) =>
      a.relPath.localeCompare(b.relPath),
    );

    const manifest: AssetManifest = {
      version: 1,
      extractedAt: new Date().toISOString(),
      sourceSha256: archive.sourceSha256,
      atlases,
      scrollers,
      gradients,
      audioSfx,
      audioMusic,
      cardIcons,
      entries,
    };

    writeOutFile('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

    const totalBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0);
    const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(2);
    console.log(
      `[extract-assets] Done in ${elapsedSec}s: ${entries.length} files (${(totalBytes / (1024 * 1024)).toFixed(1)} MB) -> .krunked-cells-assets/manifest.json`,
    );
    console.log(
      `[extract-assets] Summary: atlases=${Object.keys(atlases).length}, scrollerGroups=${Object.keys(scrollers).length}, gradients=${Object.keys(gradients).length}, cardIcons=${Object.keys(cardIcons).length}, sfxKeys=${Object.keys(audioSfx).length}, musicTracks=${Object.keys(audioMusic).length}`,
    );
  } finally {
    fs.closeSync(fd);
  }
}

main();
