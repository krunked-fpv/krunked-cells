import fs from 'node:fs';
import path from 'node:path';
import {
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  SCROLL_DAMAGE_BASE,
  SIM_HZ,
  TILE_SIZE,
  VIEWPORT_H,
  VIEWPORT_W,
  type BiomeId,
  type BossId,
} from '../src/contracts/index.ts';

const DEFAULT_PAK_PATH = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Dead Cells\\res.pak';
const OUT_DIR = path.resolve(process.cwd(), '.krunked-cells-assets');
const ORACLE_OUT_PATH = path.join(OUT_DIR, 'oracle.json');

type Provenance = 'extracted' | 'measured';

interface PakFileEntry {
  path: string;
  pos: number;
  size: number;
  crc: number;
}

interface CdbSheet {
  name: string;
  columns: Array<{ name: string; typeStr: string }>;
  lines: Array<Record<string, unknown>>;
}

interface CdbRoot {
  sheets: CdbSheet[];
}

export interface OracleBiomeRow {
  provenance: Provenance;
  id: BiomeId;
  cdbId: string;
  atlasName: string;
  ambientHex: string;
  fogHex: string;
  celShadowHex: string;
  waterHex: string;
  lightColors: string[];
}

export interface OracleWeaponRow {
  provenance: Provenance;
  id: string;
  cdbId: string;
  name: string;
  colors: string[];
  strikeChain: Array<{
    charge: number;
    coolDown: number;
    lockCtrlAfter: number;
    hitFrame: number;
    power: number[];
    breachBonus: number;
    canCrit: boolean;
    areaWidth: number;
    areaHeight: number;
    sfxRelease?: string;
    sfxHit?: string;
  }>;
}

export interface OracleMobRow {
  provenance: Provenance;
  id: string;
  cdbId: string;
  name: string;
  baseHp: number;
  lifeStages: number[];
  score: number;
  canBeElite: boolean;
}

export interface OracleDifficultyRow {
  provenance: Provenance;
  bossCells: number;
  id: string;
  name: string;
  extraLootLevel: number;
  cellDropMultiplier: number;
  goldRatio: number;
  eliteExtraLife: number;
  bossExtraLife: number;
  extraMobDensity: number;
  fountainLockLevel: number;
}

export interface OracleDump {
  version: number;
  provenance: 'extracted';
  extractedAt: string;
  sourceSha256: string;
  pakFileCount: number;
  cdbSizeBytes: number;
  sheetRowCounts: {
    provenance: 'extracted';
    counts: Record<string, number>;
  };
  hero: {
    provenance: 'extracted';
    id: string;
    name: string;
    props: Record<string, unknown>;
    skills: Array<{
      skill: string;
      cooldown: number;
      duration: number;
      props: Record<string, unknown>;
    }>;
  };
  biomes: Record<BiomeId, OracleBiomeRow>;
  weapons: Record<string, OracleWeaponRow>;
  mobs: Record<string, OracleMobRow>;
  bosses: Record<BossId, OracleMobRow>;
  difficulties: OracleDifficultyRow[];
  affixes: {
    provenance: 'extracted';
    totalCount: number;
    samples: Array<{
      id: string;
      desc: string;
      chance: number;
      costImpact: number;
    }>;
  };
  measuredNotes: {
    provenance: 'measured';
    scrollDamageBase: number;
    simHz: number;
    tileSize: number;
    viewportW: number;
    viewportH: number;
    playerWidth: number;
    playerHeight: number;
    dodgeRollDurationTicks: number;
    coyoteTimeTicks: number;
    healFlaskPowerPct: number;
    parryWindowTicks: number;
    notes: string[];
  };
}

function intToHexColor(value: unknown, fallback = '#000000'): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `#${((value >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
  }
  if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) {
    return value.toLowerCase();
  }
  return fallback;
}

function parsePakHeader(fd: number): {
  headerSize: number;
  sourceSha256: string;
  files: Map<string, PakFileEntry>;
} {
  const fixedHeader = Buffer.alloc(0x4c);
  if (fs.readSync(fd, fixedHeader, 0, fixedHeader.length, 0) < fixedHeader.length) {
    throw new Error('res.pak truncated before PAK v1 header');
  }
  const magic = fixedHeader.subarray(0, 3).toString('ascii');
  const version = fixedHeader[3];
  if (magic !== 'PAK' || version !== 1) {
    throw new Error(`Unsupported PAK header: magic=${JSON.stringify(magic)} ver=${version}`);
  }

  const headerSize = fixedHeader.readUInt32LE(4);
  const sourceSha256 = fixedHeader.subarray(0x0c, 0x4c).toString('ascii');
  const headerBuf = Buffer.alloc(headerSize);
  fs.readSync(fd, headerBuf, 0, headerSize, 0);

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
  return { headerSize, sourceSha256, files };
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

const CAMPAIGN_BIOME_MAP: ReadonlyArray<{ id: BiomeId; cdbId: string }> = [
  { id: 'PrisonStart', cdbId: 'PrisonStart' },
  { id: 'PrisonCourtyard', cdbId: 'PrisonCourtyard' },
  { id: 'Sewer', cdbId: 'Sewer' },
  { id: 'PrisonRoof', cdbId: 'PrisonRoof' },
  { id: 'Bridge', cdbId: 'Bridge' },
  { id: 'StiltVillage', cdbId: 'StiltVillage' },
  { id: 'ClockTower', cdbId: 'ClockTower' },
  { id: 'TopClockTower', cdbId: 'TopClockTower' },
  { id: 'Castle', cdbId: 'Castle' },
  { id: 'Throne', cdbId: 'Throne' },
  { id: 'Passage', cdbId: 'PrisonHub' },
];

const CURATED_WEAPON_MAP: ReadonlyArray<{ id: string; cdbId: string }> = [
  { id: 'StartSword', cdbId: 'StartSword' },
  { id: 'QuickSword', cdbId: 'QuickSword' },
  { id: 'DualDaggers', cdbId: 'DualDaggers' },
  { id: 'BackStabber', cdbId: 'BackStabber' },
  { id: 'Bleeder', cdbId: 'Bleeder' },
  { id: 'BroadSword', cdbId: 'BroadSword' },
  { id: 'StunMace', cdbId: 'StunMace' },
  { id: 'SpeedBlade', cdbId: 'SpeedBlade' },
  { id: 'ImpaleSpear', cdbId: 'ImpaleSpear' },
  { id: 'Rapier', cdbId: 'Rapier' },
  { id: 'Whip', cdbId: 'LightningWhip' },
  { id: 'CloseCombatBow', cdbId: 'CloseCombatBow' },
  { id: 'FastBow', cdbId: 'FastBow' },
  { id: 'FrostBow', cdbId: 'FrostBow' },
  { id: 'ThrowingKnife', cdbId: 'ThrowingKnife' },
  { id: 'Fireball', cdbId: 'FireBall' },
  { id: 'StartShield', cdbId: 'StartShield' },
  { id: 'StunShield', cdbId: 'Shield' },
  { id: 'BleedShield', cdbId: 'BloodShield' },
  { id: 'ForceShield', cdbId: 'Rampart' },
];

const CURATED_MOB_MAP: ReadonlyArray<{ id: string; cdbId: string }> = [
  { id: 'Zombie', cdbId: 'Zombie' },
  { id: 'Archer', cdbId: 'Archer' },
  { id: 'Grenader', cdbId: 'Grenader' },
  { id: 'Shield', cdbId: 'Shield' },
  { id: 'Mage360', cdbId: 'Mage360' },
  { id: 'Runner', cdbId: 'Runner' },
  { id: 'BatKamikaze', cdbId: 'BatKamikaze' },
  { id: 'BatDasher', cdbId: 'BatDasher' },
  { id: 'Worm', cdbId: 'Worm' },
  { id: 'Protector', cdbId: 'Shielder' },
  { id: 'Scorpio', cdbId: 'Scorpio' },
  { id: 'Comboter', cdbId: 'Comboter' },
  { id: 'Ninja', cdbId: 'Ninja' },
  { id: 'LeapingDuelyst', cdbId: 'LeapingDuelyst' },
  { id: 'ClusterGrenader', cdbId: 'ClusterGrenader' },
  { id: 'PirateChief', cdbId: 'PirateChief' },
  { id: 'CastleKnight', cdbId: 'CastleKnight' },
  { id: 'Lancer', cdbId: 'Lancer' },
];

const CURATED_BOSS_MAP: ReadonlyArray<{ id: BossId; cdbId: string }> = [
  { id: 'Behemoth', cdbId: 'Behemoth' },
  { id: 'TimeKeeper', cdbId: 'TimeKeeper' },
  { id: 'KingsHand', cdbId: 'KingsHand' },
];

function extractMobRow(
  id: string,
  cdbId: string,
  mobLines: Array<Record<string, unknown>>,
): OracleMobRow {
  const row = mobLines.find((m) => m.id === cdbId);
  if (!row) {
    throw new Error(`Missing CDB mob row for ${id} (cdbId=${cdbId})`);
  }
  const rawLife = row.life;
  const lifeStages = Array.isArray(rawLife)
    ? rawLife.map((n) => Number(n))
    : [Number(rawLife ?? 0)];
  return {
    provenance: 'extracted',
    id,
    cdbId,
    name: String(row.name ?? id),
    baseHp: lifeStages[0] ?? 0,
    lifeStages,
    score: Number(row.score ?? 0),
    canBeElite: Boolean(row.canBeElite ?? false),
  };
}

function main(): void {
  const pakPath = process.env.DEAD_CELLS_PAK || DEFAULT_PAK_PATH;

  if (!fs.existsSync(pakPath)) {
    console.log(
      `[oracle-dump] Retail res.pak not found at "${pakPath}". Skipping oracle dump (exiting 0).`,
    );
    process.exit(0);
  }

  console.log(`[oracle-dump] Opening read-only: ${pakPath}`);
  const fd = fs.openSync(pakPath, 'r');

  try {
    const archive = parsePakHeader(fd);
    const cdbEntry = archive.files.get('data.cdb');
    if (!cdbEntry) {
      throw new Error('data.cdb not found inside res.pak');
    }

    const cdbBuf = readPakEntry(fd, archive.headerSize, cdbEntry);
    const cdb = JSON.parse(cdbBuf.toString('utf8')) as CdbRoot;

    const getSheet = (name: string): Array<Record<string, unknown>> => {
      const sheet = cdb.sheets.find((s) => s.name === name);
      if (!sheet) {
        throw new Error(`CastleDB sheet "${name}" missing in data.cdb`);
      }
      return sheet.lines;
    };

    // Sheet row counts (top-level sheets)
    const sheetCounts: Record<string, number> = {};
    for (const s of cdb.sheets) {
      if (!s.name.includes('@')) {
        sheetCounts[s.name] = s.lines.length;
      }
    }

    // Hero[0]
    const hero0 = getSheet('hero')[0];
    if (!hero0) {
      throw new Error('hero[0] missing in data.cdb');
    }
    const heroProps = (hero0.props ?? {}) as Record<string, unknown>;
    const rawHeroSkills = Array.isArray(hero0.skills)
      ? (hero0.skills as Array<Record<string, unknown>>)
      : [];
    const heroSkills = rawHeroSkills.map((sk) => ({
      skill: String(sk.skill ?? ''),
      cooldown: Number(sk.cooldown ?? 0),
      duration: Number(sk.duration ?? 0),
      props: (sk.props ?? {}) as Record<string, unknown>,
    }));

    // Campaign biomes
    const biomeLines = getSheet('biome');
    const biomes = {} as Record<BiomeId, OracleBiomeRow>;
    for (const { id, cdbId } of CAMPAIGN_BIOME_MAP) {
      const row = biomeLines.find((b) => b.id === cdbId);
      if (!row) {
        throw new Error(`Missing CDB biome row for ${id} (cdbId=${cdbId})`);
      }
      const rawLights = Array.isArray(row.lightColors) ? row.lightColors : [];
      const lightColors = rawLights.map((entry) => {
        if (entry && typeof entry === 'object' && 'color' in entry) {
          return intToHexColor((entry as { color: unknown }).color);
        }
        return intToHexColor(entry);
      });
      biomes[id] = {
        provenance: 'extracted',
        id,
        cdbId,
        atlasName: String(row.atlasName ?? ''),
        ambientHex: intToHexColor(row.ambient),
        fogHex: intToHexColor(row.fog),
        celShadowHex: intToHexColor(row.celShadow),
        waterHex: intToHexColor(row.water),
        lightColors,
      };
    }

    // Curated 20 weapons
    const weaponLines = getSheet('weapon');
    const itemLines = getSheet('item');
    const itemById = new Map<string, Record<string, unknown>>();
    for (const it of itemLines) {
      if (typeof it.id === 'string') {
        itemById.set(it.id, it);
      }
    }

    const weapons: Record<string, OracleWeaponRow> = {};
    for (const { id, cdbId } of CURATED_WEAPON_MAP) {
      const wRow = weaponLines.find((w) => w.item === cdbId);
      if (!wRow) {
        throw new Error(`Missing CDB weapon row for ${id} (cdbId=${cdbId})`);
      }
      const itRow = itemById.get(cdbId);
      const colors: string[] = [];
      if (itRow?.tier1) colors.push(String(itRow.tier1));
      if (itRow?.tier2) colors.push(String(itRow.tier2));

      const rawChain = Array.isArray(wRow.strikeChain)
        ? (wRow.strikeChain as Array<Record<string, unknown>>)
        : [];
      const strikeChain = rawChain.map((step) => {
        const area = (step.area ?? {}) as Record<string, unknown>;
        const rawPower = step.power;
        const power = Array.isArray(rawPower)
          ? rawPower.map((p) => Number(p))
          : [Number(rawPower ?? 0)];
        return {
          charge: Number(step.charge ?? 0),
          coolDown: Number(step.coolDown ?? 0),
          lockCtrlAfter: Number(step.lockCtrlAfter ?? 0),
          hitFrame: Number(step.hitFrame ?? 0),
          power,
          breachBonus: Number(step.breachBonus ?? 0),
          canCrit: Boolean(step.canCrit ?? false),
          areaWidth: Number(area.width ?? 0),
          areaHeight: Number(area.height ?? 0),
          ...(typeof step.sfxRelease === 'string' ? { sfxRelease: step.sfxRelease } : {}),
          ...(typeof step.sfxHit === 'string' ? { sfxHit: step.sfxHit } : {}),
        };
      });

      weapons[id] = {
        provenance: 'extracted',
        id,
        cdbId,
        name: String(itRow?.name ?? id),
        colors,
        strikeChain,
      };
    }

    // Curated 18 mobs & 3 bosses
    const mobLines = getSheet('mob');
    const mobs: Record<string, OracleMobRow> = {};
    for (const { id, cdbId } of CURATED_MOB_MAP) {
      mobs[id] = extractMobRow(id, cdbId, mobLines);
    }

    const bosses = {} as Record<BossId, OracleMobRow>;
    for (const { id, cdbId } of CURATED_BOSS_MAP) {
      bosses[id] = extractMobRow(id, cdbId, mobLines);
    }

    // Difficulty 0BC..5BC
    const difficultyLines = getSheet('difficulty');
    const difficulties: OracleDifficultyRow[] = difficultyLines
      .map((d) => ({
        provenance: 'extracted' as const,
        bossCells: Number(d.difficultyLevel ?? 0),
        id: String(d.id ?? ''),
        name: String(d.name ?? ''),
        extraLootLevel: Number(d.extraLootLevel ?? 0),
        cellDropMultiplier: Number(d.cellDropMultiplier ?? 1),
        goldRatio: Number(d.goldRatio ?? 1),
        eliteExtraLife: Number(d.eliteExtraLife ?? 0),
        bossExtraLife: Number(d.bossExtraLife ?? 0),
        extraMobDensity: Number(d.extraMobDensity ?? 0),
        fountainLockLevel: Number(d.fountainLockLevel ?? 0),
      }))
      .sort((a, b) => a.bossCells - b.bossCells);

    // Affixes
    const affixLines = getSheet('affix');
    const affixSamples = affixLines.slice(0, 20).map((a) => ({
      id: String(a.id ?? ''),
      desc: String(a.desc ?? ''),
      chance: Number(a.chance ?? 0),
      costImpact: Number(a.costImpact ?? 0),
    }));

    // Derived measured mechanic notes
    const dodgeSkill = heroSkills.find((s) => s.skill === 'DodgeRoll');
    const flaskSkill = heroSkills.find((s) => s.skill === 'HealFlask');
    const dodgeDurationSec = dodgeSkill?.duration ?? 0.4;
    const coyoteSec = Number(heroProps.coyoteTime ?? 0.12);
    const flaskPower = Number(flaskSkill?.props?.power ?? 0.6);

    const oracle: OracleDump = {
      version: 1,
      provenance: 'extracted',
      extractedAt: new Date().toISOString(),
      sourceSha256: archive.sourceSha256,
      pakFileCount: archive.files.size,
      cdbSizeBytes: cdbEntry.size,
      sheetRowCounts: {
        provenance: 'extracted',
        counts: sheetCounts,
      },
      hero: {
        provenance: 'extracted',
        id: String(hero0.id ?? 'Beheaded'),
        name: String(hero0.name ?? 'Beheaded'),
        props: heroProps,
        skills: heroSkills,
      },
      biomes,
      weapons,
      mobs,
      bosses,
      difficulties,
      affixes: {
        provenance: 'extracted',
        totalCount: affixLines.length,
        samples: affixSamples,
      },
      measuredNotes: {
        provenance: 'measured',
        scrollDamageBase: SCROLL_DAMAGE_BASE,
        simHz: SIM_HZ,
        tileSize: TILE_SIZE,
        viewportW: VIEWPORT_W,
        viewportH: VIEWPORT_H,
        playerWidth: PLAYER_WIDTH,
        playerHeight: PLAYER_HEIGHT,
        dodgeRollDurationTicks: Math.round(dodgeDurationSec * SIM_HZ),
        coyoteTimeTicks: Math.min(6, Math.round(coyoteSec * SIM_HZ)),
        healFlaskPowerPct: flaskPower,
        parryWindowTicks: 16,
        notes: [
          `DodgeRoll extracted duration=${dodgeDurationSec}s -> ${Math.round(dodgeDurationSec * SIM_HZ)} ticks @ ${SIM_HZ}Hz`,
          `Hero coyoteTime extracted=${coyoteSec}s; calibrated to 6 ticks (100ms) per SPEC.md`,
          `HealFlask extracted power=${flaskPower} (60% max HP)`,
          'Scroll scaling exponential base 1.15^(n-1) calibrated per SPEC.md',
          'BatKamikaze/BatDasher extracted life=1 in retail; tuned to 15/25 in SPEC.md for readable combat feel',
        ],
      },
    };

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(ORACLE_OUT_PATH, `${JSON.stringify(oracle, null, 2)}\n`, 'utf8');

    console.log(
      `[oracle-dump] Wrote ${ORACLE_OUT_PATH}: biomes=${Object.keys(biomes).length}, weapons=${Object.keys(weapons).length}, mobs=${Object.keys(mobs).length}, bosses=${Object.keys(bosses).length}, difficulties=${difficulties.length}, affixes=${affixLines.length}`,
    );
  } finally {
    fs.closeSync(fd);
  }
}

main();
