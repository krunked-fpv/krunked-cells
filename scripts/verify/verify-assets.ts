import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MAX_BOSS_CELLS,
  SCROLL_DAMAGE_BASE,
  SIM_HZ,
  TILE_SIZE,
  VIEWPORT_H,
  VIEWPORT_W,
  type AssetManifest,
  type BiomeDef,
  type BiomeId,
  type BossDef,
  type BossId,
  type DifficultyDef,
  type EnemyDef,
  type MutationDef,
  type SkillDef,
  type WeaponDef,
} from '../../src/contracts/index.ts';

interface CheckResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail: string;
}

interface DataCatalogModule {
  BIOMES?: BiomeDef[];
  BIOME_MAP?: Record<string, BiomeDef>;
  WEAPONS?: WeaponDef[];
  WEAPON_MAP?: Record<string, WeaponDef>;
  SKILLS?: SkillDef[];
  SKILL_MAP?: Record<string, SkillDef>;
  MUTATIONS?: MutationDef[];
  MUTATION_MAP?: Record<string, MutationDef>;
  ENEMIES?: EnemyDef[];
  ENEMY_MAP?: Record<string, EnemyDef>;
  BOSSES?: BossDef[];
  BOSS_MAP?: Record<string, BossDef>;
  DIFFICULTIES?: DifficultyDef[];
}

interface OracleJson {
  provenance?: string;
  biomes?: Record<
    string,
    {
      ambientHex?: string;
      fogHex?: string;
      celShadowHex?: string;
      waterHex?: string;
    }
  >;
  weapons?: Record<string, unknown>;
  mobs?: Record<string, unknown>;
  bosses?: Record<string, { baseHp?: number }>;
  difficulties?: Array<{ bossCells?: number }>;
  measuredNotes?: { scrollDamageBase?: number };
}

const ROOT_DIR = process.cwd();
const PACK_DIR = path.join(ROOT_DIR, '.krunked-cells-assets');
const MANIFEST_PATH = path.join(PACK_DIR, 'manifest.json');
const ORACLE_PATH = path.join(PACK_DIR, 'oracle.json');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const DATA_INDEX_PATH = path.join(ROOT_DIR, 'src', 'data', 'index.ts');

const FORBIDDEN_PATH_SEGMENTS = ['.krunked-cells-assets', '__custom_pack__'];
const FORBIDDEN_EXTENSIONS = new Set([
  '.pak',
  '.cdb',
  '.hdll',
  '.exe',
  '.dll',
  '.atlas',
  '.wav',
  '.ogg',
  '.mp3',
  '.fnt',
  '.tmx',
  '.tsx',
  '.png',
  '.jpg',
  '.jpeg',
]);

const EXPECTED_BOSS_ORACLE_HP: Record<BossId, number> = {
  Behemoth: 4000,
  TimeKeeper: 2500,
  KingsHand: 5900,
};

const REQUIRED_BIOME_IDS: readonly BiomeId[] = [
  'PrisonStart',
  'PrisonCourtyard',
  'Sewer',
  'PrisonRoof',
  'Bridge',
  'StiltVillage',
  'ClockTower',
  'TopClockTower',
  'Castle',
  'Throne',
  'Passage',
];

function isForbiddenRetailPath(relPath: string): string | null {
  const normalized = relPath.replace(/\\/g, '/').toLowerCase();
  const segments = normalized.split('/');
  for (const forbiddenSeg of FORBIDDEN_PATH_SEGMENTS) {
    if (segments.includes(forbiddenSeg)) {
      return `forbidden directory "${forbiddenSeg}"`;
    }
  }
  const ext = path.posix.extname(normalized);
  if (FORBIDDEN_EXTENSIONS.has(ext)) {
    return `forbidden retail/binary extension "${ext}"`;
  }
  return null;
}

function walkDirectoryRel(baseDir: string, currentDir = baseDir): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(currentDir, entry.name);
    const rel = path.relative(baseDir, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      results.push(rel);
      results.push(...walkDirectoryRel(baseDir, full));
    } else {
      results.push(rel);
    }
  }
  return results;
}

function checkGitIpFirewall(): CheckResult {
  let stdout: string;
  try {
    stdout = execFileSync('git', ['ls-files', '-z'], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    return {
      name: 'IP Firewall (git ls-files)',
      status: 'FAIL',
      detail: `git ls-files failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const trackedFiles = stdout.split('\0').filter((f) => f.length > 0);
  const violations: string[] = [];

  for (const file of trackedFiles) {
    const reason = isForbiddenRetailPath(file);
    if (reason) {
      violations.push(`${file} (${reason})`);
    }
  }

  if (violations.length > 0) {
    return {
      name: 'IP Firewall (git ls-files)',
      status: 'FAIL',
      detail: `${violations.length} forbidden tracked file(s): ${violations.slice(0, 10).join(', ')}`,
    };
  }

  return {
    name: 'IP Firewall (git ls-files)',
    status: 'PASS',
    detail: `Scanned ${trackedFiles.length} tracked files — 0 retail/pack leaks`,
  };
}

function checkDistIpFirewall(): CheckResult {
  if (!fs.existsSync(DIST_DIR)) {
    return {
      name: 'IP Firewall (dist/)',
      status: 'SKIP',
      detail: 'dist/ directory not present yet',
    };
  }

  const distItems = walkDirectoryRel(DIST_DIR);
  const violations: string[] = [];

  for (const item of distItems) {
    const reason = isForbiddenRetailPath(item);
    if (reason) {
      violations.push(`dist/${item} (${reason})`);
    }
  }

  if (violations.length > 0) {
    return {
      name: 'IP Firewall (dist/)',
      status: 'FAIL',
      detail: `${violations.length} leaked file(s) in dist/: ${violations.slice(0, 10).join(', ')}`,
    };
  }

  return {
    name: 'IP Firewall (dist/)',
    status: 'PASS',
    detail: `Scanned ${distItems.length} dist entries — 0 retail/pack leaks`,
  };
}

function checkContractInvariants(): CheckResult {
  const failures: string[] = [];
  if (SCROLL_DAMAGE_BASE !== 1.15) {
    failures.push(`SCROLL_DAMAGE_BASE=${SCROLL_DAMAGE_BASE} (expected 1.15)`);
  }
  if (MAX_BOSS_CELLS !== 5) {
    failures.push(`MAX_BOSS_CELLS=${MAX_BOSS_CELLS} (expected 5)`);
  }
  if (SIM_HZ !== 60) {
    failures.push(`SIM_HZ=${SIM_HZ} (expected 60)`);
  }
  if (TILE_SIZE !== 24) {
    failures.push(`TILE_SIZE=${TILE_SIZE} (expected 24)`);
  }
  if (VIEWPORT_W !== 480 || VIEWPORT_H !== 270) {
    failures.push(`VIEWPORT=${VIEWPORT_W}x${VIEWPORT_H} (expected 480x270)`);
  }

  if (failures.length > 0) {
    return {
      name: 'Contract Quantitative Invariants',
      status: 'FAIL',
      detail: failures.join('; '),
    };
  }

  return {
    name: 'Contract Quantitative Invariants',
    status: 'PASS',
    detail: 'SCROLL_DAMAGE_BASE=1.15, MAX_BOSS_CELLS=5, SIM_HZ=60, TILE_SIZE=24, 480x270',
  };
}

function checkManifestIntegrity(): CheckResult {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return {
      name: 'Custom Pack Manifest Integrity',
      status: 'SKIP',
      detail: '.krunked-cells-assets/manifest.json not present (optional local pack)',
    };
  }

  let manifest: AssetManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as AssetManifest;
  } catch (err) {
    return {
      name: 'Custom Pack Manifest Integrity',
      status: 'FAIL',
      detail: `Failed to parse manifest.json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const allPaths = new Set<string>();
  const errors: string[] = [];

  if (typeof manifest.version !== 'number' || !manifest.sourceSha256 || !Array.isArray(manifest.entries)) {
    errors.push('Manifest missing required header fields (version, sourceSha256, entries)');
  }

  for (const entry of manifest.entries ?? []) {
    if (!entry.relPath) {
      errors.push(`Entry with key="${entry.key}" has empty relPath`);
      continue;
    }
    allPaths.add(entry.relPath);
  }

  for (const [atlasKey, atlas] of Object.entries(manifest.atlases ?? {})) {
    allPaths.add(atlas.atlasFile);
    for (const p of atlas.pages ?? []) allPaths.add(p);
    for (const np of atlas.normalPages ?? []) allPaths.add(np);
    if (atlas.tracksFile) allPaths.add(atlas.tracksFile);
    if (atlas.skinFile) allPaths.add(atlas.skinFile);

    // Ensure extracted .atlas is readable libGDX text, not raw binary BATL
    const atlasAbs = path.resolve(PACK_DIR, atlas.atlasFile);
    if (fs.existsSync(atlasAbs)) {
      const head = Buffer.alloc(4);
      const fd = fs.openSync(atlasAbs, 'r');
      try {
        fs.readSync(fd, head, 0, 4, 0);
      } finally {
        fs.closeSync(fd);
      }
      if (head.toString('ascii') === 'BATL') {
        errors.push(`Atlas "${atlasKey}" (${atlas.atlasFile}) is unconverted binary BATL`);
      }
    }
  }

  for (const groupPaths of Object.values(manifest.scrollers ?? {})) {
    for (const p of groupPaths) allPaths.add(p);
  }
  for (const p of Object.values(manifest.gradients ?? {})) {
    allPaths.add(p);
  }
  for (const p of Object.values(manifest.audioSfx ?? {})) {
    allPaths.add(p);
  }
  for (const track of Object.values(manifest.audioMusic ?? {})) {
    if (track.intro) allPaths.add(track.intro);
    allPaths.add(track.loop);
  }

  const rootWithSep = PACK_DIR.endsWith(path.sep) ? PACK_DIR : `${PACK_DIR}${path.sep}`;
  let verifiedCount = 0;

  for (const relPath of allPaths) {
    const absPath = path.resolve(PACK_DIR, relPath);
    if (!absPath.startsWith(rootWithSep)) {
      errors.push(`Path escapes pack directory: ${relPath}`);
      continue;
    }
    if (!fs.existsSync(absPath)) {
      errors.push(`Missing file on disk: ${relPath}`);
      continue;
    }
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size <= 0) {
      errors.push(`Empty or non-file asset: ${relPath} (size=${stat.size})`);
      continue;
    }
    verifiedCount++;
  }

  if (allPaths.size === 0) {
    errors.push('Manifest lists zero files');
  }

  const cardIcons = manifest.cardIcons ?? {};
  const cardIconEntries = Object.entries(cardIcons);
  if (cardIconEntries.length > 0) {
    if (!allPaths.has('cardIcons.png')) {
      errors.push('Manifest defines cardIcons coordinates but cardIcons.png is missing');
    }
    for (const [iconId, rect] of cardIconEntries) {
      if (
        !rect ||
        typeof rect.x !== 'number' ||
        typeof rect.y !== 'number' ||
        typeof rect.size !== 'number' ||
        rect.x < 0 ||
        rect.y < 0 ||
        rect.size <= 0
      ) {
        errors.push(`Invalid cardIcons rect for "${iconId}"`);
      }
    }
  }

  if (errors.length > 0) {
    return {
      name: 'Custom Pack Manifest Integrity',
      status: 'FAIL',
      detail: `${errors.length} error(s): ${errors.slice(0, 8).join('; ')}`,
    };
  }

  return {
    name: 'Custom Pack Manifest Integrity',
    status: 'PASS',
    detail: `Verified ${verifiedCount} unique files on disk (>0 bytes), ${Object.keys(manifest.atlases ?? {}).length} atlases, ${Object.keys(manifest.scrollers ?? {}).length} scroller groups, ${cardIconEntries.length} cardIcons, ${Object.keys(manifest.audioSfx ?? {}).length} SFX keys, ${Object.keys(manifest.audioMusic ?? {}).length} music tracks`,
  };
}

function loadOracleJson(): { oracle: OracleJson | null; check: CheckResult } {
  if (!fs.existsSync(ORACLE_PATH)) {
    return {
      oracle: null,
      check: {
        name: 'Oracle Dump Integrity',
        status: 'SKIP',
        detail: '.krunked-cells-assets/oracle.json not present (optional local oracle)',
      },
    };
  }

  let oracle: OracleJson;
  try {
    oracle = JSON.parse(fs.readFileSync(ORACLE_PATH, 'utf8')) as OracleJson;
  } catch (err) {
    return {
      oracle: null,
      check: {
        name: 'Oracle Dump Integrity',
        status: 'FAIL',
        detail: `Failed to parse oracle.json: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  const errors: string[] = [];
  if (oracle.provenance !== 'extracted') {
    errors.push(`oracle.provenance=${String(oracle.provenance)} (expected "extracted")`);
  }
  if ((oracle.difficulties?.length ?? 0) !== 6) {
    errors.push(`oracle.difficulties.length=${oracle.difficulties?.length ?? 0} (expected 6)`);
  }
  for (const [bossId, expectedHp] of Object.entries(EXPECTED_BOSS_ORACLE_HP)) {
    const actual = oracle.bosses?.[bossId]?.baseHp;
    if (actual !== expectedHp) {
      errors.push(`oracle.bosses.${bossId}.baseHp=${String(actual)} (expected ${expectedHp})`);
    }
  }
  for (const biomeId of REQUIRED_BIOME_IDS) {
    const b = oracle.biomes?.[biomeId];
    if (!b) {
      errors.push(`oracle.biomes missing "${biomeId}"`);
      continue;
    }
    for (const key of ['ambientHex', 'fogHex', 'celShadowHex', 'waterHex'] as const) {
      if (!b[key] || !/^#[0-9a-f]{6}$/i.test(b[key])) {
        errors.push(`oracle.biomes.${biomeId}.${key} invalid: ${String(b[key])}`);
      }
    }
  }
  const weaponCount = Object.keys(oracle.weapons ?? {}).length;
  const mobCount = Object.keys(oracle.mobs ?? {}).length;
  if (weaponCount < 20) errors.push(`oracle.weapons count=${weaponCount} (expected >= 20)`);
  if (mobCount < 18) errors.push(`oracle.mobs count=${mobCount} (expected >= 18)`);

  if (errors.length > 0) {
    return {
      oracle,
      check: {
        name: 'Oracle Dump Integrity',
        status: 'FAIL',
        detail: errors.slice(0, 8).join('; '),
      },
    };
  }

  return {
    oracle,
    check: {
      name: 'Oracle Dump Integrity',
      status: 'PASS',
      detail: `Verified 11 biomes, ${weaponCount} weapons, ${mobCount} mobs, 3 bosses (4000/2500/5900 HP), 6 difficulties`,
    },
  };
}

async function checkCatalogAndOracleParity(oracle: OracleJson | null): Promise<CheckResult[]> {
  if (!fs.existsSync(DATA_INDEX_PATH)) {
    return [
      {
        name: 'Catalog Key Resolution & Consistency',
        status: 'SKIP',
        detail: 'src/data/index.ts not present in this worktree yet',
      },
      {
        name: 'Quantitative Oracle Parity',
        status: 'SKIP',
        detail: 'src/data/index.ts not present in this worktree yet',
      },
    ];
  }

  let catalog: DataCatalogModule;
  try {
    const modUrl = pathToFileURL(DATA_INDEX_PATH).href;
    catalog = (await import(modUrl)) as DataCatalogModule;
  } catch (err) {
    return [
      {
        name: 'Catalog Key Resolution & Consistency',
        status: 'FAIL',
        detail: `Failed to import src/data/index.ts: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }

  const catalogErrors: string[] = [];
  const weapons = catalog.WEAPONS ?? [];
  const skills = catalog.SKILLS ?? [];
  const enemies = catalog.ENEMIES ?? [];
  const bosses = catalog.BOSSES ?? [];
  const biomes = catalog.BIOMES ?? [];
  const mutations = catalog.MUTATIONS ?? [];
  const difficulties = catalog.DIFFICULTIES ?? [];

  const checkUniqueIds = (label: string, items: Array<{ id?: string; name?: string }>): Set<string> => {
    const ids = new Set<string>();
    for (const item of items) {
      if (!item.id || typeof item.id !== 'string' || item.id.trim().length === 0) {
        catalogErrors.push(`${label} entry has empty id`);
        continue;
      }
      if (ids.has(item.id)) {
        catalogErrors.push(`Duplicate ${label} id: ${item.id}`);
      }
      ids.add(item.id);
      if (!item.name || typeof item.name !== 'string' || item.name.trim().length === 0) {
        catalogErrors.push(`${label} "${item.id}" has empty name`);
      }
    }
    return ids;
  };

  const weaponIds = checkUniqueIds('weapon', weapons);
  const skillIds = checkUniqueIds('skill', skills);
  const enemyIds = checkUniqueIds('enemy', enemies);
  const bossIds = checkUniqueIds('boss', bosses);
  const biomeIds = checkUniqueIds('biome', biomes);
  checkUniqueIds('mutation', mutations);

  for (const w of weapons) {
    if (!w.spriteKey?.trim()) catalogErrors.push(`Weapon "${w.id}" missing spriteKey`);
    if (!w.sfxKey?.trim()) catalogErrors.push(`Weapon "${w.id}" missing sfxKey`);
    if (!Array.isArray(w.strikeChain) || w.strikeChain.length === 0) {
      catalogErrors.push(`Weapon "${w.id}" has empty strikeChain`);
    }
  }
  for (const s of skills) {
    if (!s.spriteKey?.trim()) catalogErrors.push(`Skill "${s.id}" missing spriteKey`);
    if (!s.sfxKey?.trim()) catalogErrors.push(`Skill "${s.id}" missing sfxKey`);
  }
  for (const e of enemies) {
    if (!e.spriteKey?.trim()) catalogErrors.push(`Enemy "${e.id}" missing spriteKey`);
    for (const bId of e.biomes ?? []) {
      if (!biomeIds.has(bId)) {
        catalogErrors.push(`Enemy "${e.id}" references unknown biome "${bId}"`);
      }
    }
  }
  for (const b of bosses) {
    if (!b.spriteKey?.trim()) catalogErrors.push(`Boss "${b.id}" missing spriteKey`);
    if (!biomeIds.has(b.biomeId)) {
      catalogErrors.push(`Boss "${b.id}" references unknown biomeId "${b.biomeId}"`);
    }
  }
  for (const bm of biomes) {
    if (!bm.musicKey?.trim()) catalogErrors.push(`Biome "${bm.id}" missing musicKey`);
    if (!bm.tilesetTheme?.trim()) catalogErrors.push(`Biome "${bm.id}" missing tilesetTheme`);
    if (!bm.scrollerTheme?.trim()) catalogErrors.push(`Biome "${bm.id}" missing scrollerTheme`);
    for (const nextId of bm.nextBiomes ?? []) {
      if (!biomeIds.has(nextId)) {
        catalogErrors.push(`Biome "${bm.id}" nextBiomes references unknown biome "${nextId}"`);
      }
    }
    if (bm.bossId && !bossIds.has(bm.bossId)) {
      catalogErrors.push(`Biome "${bm.id}" references unknown bossId "${bm.bossId}"`);
    }
    for (const eId of bm.enemyPool ?? []) {
      if (!enemyIds.has(eId)) {
        catalogErrors.push(`Biome "${bm.id}" enemyPool references unknown enemy "${eId}"`);
      }
    }
  }

  const catalogCheck: CheckResult =
    catalogErrors.length > 0
      ? {
          name: 'Catalog Key Resolution & Consistency',
          status: 'FAIL',
          detail: `${catalogErrors.length} error(s): ${catalogErrors.slice(0, 8).join('; ')}`,
        }
      : {
          name: 'Catalog Key Resolution & Consistency',
          status: 'PASS',
          detail: `Validated weapons=${weaponIds.size}, skills=${skillIds.size}, enemies=${enemyIds.size}, bosses=${bossIds.size}, biomes=${biomeIds.size}, mutations=${mutations.length}`,
        };

  // Quantitative Oracle Parity checks (core counts & HPs always asserted; hexes cross-checked against oracle.json when present)
  const parityErrors: string[] = [];
  if (SCROLL_DAMAGE_BASE !== 1.15) {
    parityErrors.push(`SCROLL_DAMAGE_BASE=${SCROLL_DAMAGE_BASE} !== 1.15`);
  }
  if (difficulties.length !== 6) {
    parityErrors.push(`DIFFICULTIES.length=${difficulties.length} !== 6`);
  }
  if (weapons.length < 20) {
    parityErrors.push(`WEAPONS.length=${weapons.length} < 20`);
  }
  if (enemies.length < 18) {
    parityErrors.push(`ENEMIES.length=${enemies.length} < 18`);
  }
  for (const [bossId, expectedHp] of Object.entries(EXPECTED_BOSS_ORACLE_HP)) {
    const boss = bosses.find((b) => b.id === bossId);
    if (!boss) {
      parityErrors.push(`Missing boss "${bossId}" in BOSSES`);
    } else if (boss.baseHp !== expectedHp) {
      parityErrors.push(`Boss "${bossId}" baseHp=${boss.baseHp} !== ${expectedHp}`);
    }
  }

  if (oracle) {
    if ((oracle.difficulties?.length ?? 0) !== difficulties.length) {
      parityErrors.push(
        `Difficulty count mismatch: catalog=${difficulties.length} vs oracle=${oracle.difficulties?.length ?? 0}`,
      );
    }
    for (const [bossId, expectedHp] of Object.entries(EXPECTED_BOSS_ORACLE_HP)) {
      const oracleHp = oracle.bosses?.[bossId]?.baseHp;
      const boss = bosses.find((b) => b.id === bossId);
      if (boss && oracleHp !== undefined && boss.baseHp !== oracleHp) {
        parityErrors.push(
          `Boss "${bossId}" HP mismatch: catalog=${boss.baseHp} vs oracle=${oracleHp} (expected ${expectedHp})`,
        );
      }
    }
    for (const biomeId of REQUIRED_BIOME_IDS) {
      const catBiome = biomes.find((b) => b.id === biomeId);
      const orcBiome = oracle.biomes?.[biomeId];
      if (!catBiome) {
        parityErrors.push(`Missing campaign biome "${biomeId}" in BIOMES`);
        continue;
      }
      if (!orcBiome) continue;
      for (const field of ['ambientHex', 'fogHex', 'celShadowHex', 'waterHex'] as const) {
        const catHex = catBiome[field]?.toLowerCase();
        const orcHex = orcBiome[field]?.toLowerCase();
        if (orcHex && catHex !== orcHex) {
          parityErrors.push(`Biome "${biomeId}".${field} mismatch: catalog=${catHex} vs oracle=${orcHex}`);
        }
      }
    }
  }

  const parityCheck: CheckResult =
    parityErrors.length > 0
      ? {
          name: 'Quantitative Oracle Parity',
          status: 'FAIL',
          detail: `${parityErrors.length} mismatch(es): ${parityErrors.slice(0, 8).join('; ')}`,
        }
      : {
          name: 'Quantitative Oracle Parity',
          status: 'PASS',
          detail: oracle
            ? 'SCROLL_DAMAGE_BASE=1.15, 6 difficulties, boss HPs (4000/2500/5900), 11 biome hex palettes, >=20 weapons, >=18 enemies all match oracle.json'
            : 'SCROLL_DAMAGE_BASE=1.15, 6 difficulties, boss HPs (4000/2500/5900), >=20 weapons, >=18 enemies verified (oracle.json absent in CI)',
        };

  return [catalogCheck, parityCheck];
}

async function main(): Promise<void> {
  const results: CheckResult[] = [];

  results.push(checkGitIpFirewall());
  results.push(checkDistIpFirewall());
  results.push(checkContractInvariants());
  results.push(checkManifestIntegrity());

  const { oracle, check: oracleCheck } = loadOracleJson();
  results.push(oracleCheck);

  const catalogChecks = await checkCatalogAndOracleParity(oracle);
  results.push(...catalogChecks);

  const failed = results.filter((r) => r.status === 'FAIL');
  const passed = results.filter((r) => r.status === 'PASS');
  const skipped = results.filter((r) => r.status === 'SKIP');

  console.log('\n============================================================');
  console.log(' KRUNKED CELLS — GATE A: ASSET & IP FIREWALL REPORT');
  console.log('============================================================');
  for (const r of results) {
    const tag = r.status === 'PASS' ? '[PASS]' : r.status === 'FAIL' ? '[FAIL]' : '[SKIP]';
    console.log(`${tag} ${r.name}`);
    console.log(`       ${r.detail}`);
  }
  console.log('------------------------------------------------------------');
  console.log(
    `Result: ${failed.length === 0 ? 'GATE A PASSED' : 'GATE A FAILED'} (pass=${passed.length}, skip=${skipped.length}, fail=${failed.length})`,
  );
  console.log('============================================================\n');

  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[verify-assets] Fatal error:', err);
  process.exit(1);
});
