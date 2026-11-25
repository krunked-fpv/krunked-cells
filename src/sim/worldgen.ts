// =============================================================================
// KRUNKED CELLS — Procedural Metroidvania Worldgen, Boss Arenas, Passage Room
//                 & Tile-Space BFS Reachability Verifier + Self-Repair
// Pure simulation module: strictly deterministic, zero browser/DOM dependencies.
// =============================================================================

import {
  PLAYER_HEIGHT,
  TILE_SIZE,
  TileKind,
  type BiomeDef,
  type BiomeId,
  type CollisionAPI,
  type GearInstance,
  type LightSource,
  type RngAPI,
  type RoomNode,
  type RoomType,
  type ScrollStat,
  type SimState,
  type TileGrid,
  type TileKindValue,
  type Vec2,
} from '../contracts';
import { WEAPON_MAP, getBiome, getBoss, getEnemy, getWeapon } from '../data';
import { spawnBoss } from './bosses';
import { spawnEnemy } from './enemies';
import { enterPassageRoom } from './passage';
import { rollGearInstance } from './roguelite';

const ALL_SCROLL_STATS: readonly ScrollStat[] = ['brutality', 'tactics', 'survival'];

const OUTDOOR_BIOMES = new Set<BiomeId>([
  'PrisonCourtyard',
  'PrisonRoof',
  'Bridge',
  'StiltVillage',
  'Throne',
]);

function setBgTile(grid: TileGrid, tx: number, ty: number, val: TileKindValue | 0): void {
  if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return;
  grid.bgTiles[ty * grid.width + tx] = val;
}

function carveRoomBackground(
  grid: TileGrid,
  biomeId: BiomeId,
  innerTx: number,
  innerTy: number,
  innerTw: number,
  innerTh: number,
  floorTy: number
): void {
  if (OUTDOOR_BIOMES.has(biomeId)) {
    // Open twilight / storm sky across the entire chamber so Pass 1 parallax moon,
    // castles, spires, clouds, and god-rays shine unobstructed!
    for (let y = innerTy; y < floorTy; y++) {
      for (let x = innerTx; x < innerTx + innerTw; x++) {
        setBgTile(grid, x, y, 0);
      }
    }
    // Keep cleanly spaced gothic bridge/tower piers (no blocky 1-tile floor boxes behind braziers!)
    for (let x = innerTx; x < innerTx + innerTw; x++) {
      if ((x - innerTx) % 10 === 0 && x > innerTx + 1 && x < innerTx + innerTw - 2) {
        for (let y = innerTy; y < floorTy; y++) {
          setBgTile(grid, x, y, TileKind.BG_WALL);
        }
      }
    }
    return;
  }

  // Indoor underground/cathedral halls (PrisonStart, Sewer, Passage, Castle, ClockTower):
  // Keep continuous solid stone bgTiles so real Dead Cells masonry, arches, and wall torches
  // light seamlessly with ZERO jarring bright rectangular window cutouts behind arches!
  if (biomeId === 'TopClockTower') {
    const centers = [innerTx + 12, innerTx + 27];
    const cy = innerTy + innerTh * 0.46;
    const rad = Math.min(innerTw, innerTh) * 0.44;
    for (let y = innerTy; y < floorTy - 1; y++) {
      for (let x = innerTx + 2; x < innerTx + innerTw - 2; x++) {
        for (const cx of centers) {
          const dx = (x + 0.5 - cx) * 0.85;
          const dy = y + 0.5 - cy;
          if (dx * dx + dy * dy <= rad * rad) {
            setBgTile(grid, x, y, 0);
          }
        }
      }
    }
    return;
  }
}

const GRID_PAD_X = 2;
const GRID_PAD_Y = 2;
const GRID_PAD_Y_BOTTOM = 6; // Room for 6x3 CRACKED_FLOOR secret cellars even on bottom row

interface BiomeLayoutProfile {
  gridCols: number;
  gridRows: number;
  cellW: number;
  cellH: number;
  startGx: number;
  startGy: number;
  innerHOverride?: number;
  dirs: readonly [number, number][];
}

function getBiomeLayoutProfile(biomeId: BiomeId): BiomeLayoutProfile {
  switch (biomeId) {
    case 'PrisonCourtyard':
      // Wide horizontal Promenade boulevard + towers above + underground crypts below
      return {
        gridCols: 7,
        gridRows: 4,
        cellW: 22,
        cellH: 11,
        startGx: 0,
        startGy: 1,
        dirs: [
          [1, 0],
          [1, 0],
          [1, 0],
          [0, 1],
          [0, -1],
          [-1, 0],
        ],
      };
    case 'Sewer':
      // Cramped flooded subterranean tunnels with abundant acid & secret cellars
      return {
        gridCols: 6,
        gridRows: 4,
        cellW: 20,
        cellH: 10,
        startGx: 0,
        startGy: 1,
        innerHOverride: 5,
        dirs: [
          [1, 0],
          [1, 0],
          [0, 1],
          [0, 1],
          [-1, 0],
          [0, -1],
        ],
      };
    case 'ClockTower':
      // Tall vertical ascent tower: enter at bottom, climb 6 stories to the Clock Room exit!
      return {
        gridCols: 4,
        gridRows: 6,
        cellW: 20,
        cellH: 11,
        startGx: 1,
        startGy: 5,
        dirs: [
          [0, -1],
          [0, -1],
          [1, 0],
          [-1, 0],
          [0, 1],
        ],
      };
    case 'Castle':
      // Grand tall vaulted royal halls (double-wide merged chambers)
      return {
        gridCols: 6,
        gridRows: 4,
        cellW: 22,
        cellH: 12,
        startGx: 0,
        startGy: 1,
        dirs: [
          [1, 0],
          [1, 0],
          [0, 1],
          [0, -1],
          [-1, 0],
        ],
      };
    case 'PrisonRoof':
      // High open-sky battlements & rooftop chasms
      return {
        gridCols: 6,
        gridRows: 4,
        cellW: 22,
        cellH: 11,
        startGx: 0,
        startGy: 1,
        dirs: [
          [1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
          [-1, 0],
        ],
      };
    default:
      return {
        gridCols: 6,
        gridRows: 4,
        cellW: 22,
        cellH: 11,
        startGx: 0,
        startGy: 1,
        dirs: [
          [1, 0],
          [1, 0],
          [0, 1],
          [0, -1],
          [-1, 0],
        ],
      };
  }
}

function createEmptyGrid(width: number, height: number): TileGrid {
  const count = width * height;
  const tiles = new Uint8Array(count);
  tiles.fill(TileKind.SOLID);
  const bgTiles = new Uint8Array(count);
  bgTiles.fill(TileKind.BG_WALL);
  const explored = new Uint8Array(count);
  return { width, height, tiles, bgTiles, explored };
}

function hexToRgb01(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  if (clean.length < 6) return [1, 0.72, 0.35];
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return [
    Number.isFinite(r) ? r : 1,
    Number.isFinite(g) ? g : 0.7,
    Number.isFinite(b) ? b : 0.35,
  ];
}

function fillTileRect(
  grid: TileGrid,
  col: CollisionAPI,
  tx: number,
  ty: number,
  tw: number,
  th: number,
  kind: TileKindValue
): void {
  for (let y = ty; y < ty + th; y++) {
    for (let x = tx; x < tx + tw; x++) {
      col.setTile(grid, x, y, kind);
    }
  }
}

function addWorldLight(
  state: SimState,
  x: number,
  y: number,
  radius: number,
  color: [number, number, number],
  intensity: number,
  kind: LightSource['kind'],
  flickerSpeed = 4.5,
  flickerAmp = 0.14
): void {
  state.lights.push({
    id: state.nextUid++,
    x,
    y,
    radius,
    color,
    intensity,
    flickerSpeed,
    flickerAmp,
    kind,
  });
}

function ensureHomunculusLight(state: SimState): void {
  state.lights.unshift({
    id: 1,
    x: state.player.pos.x,
    y: state.player.pos.y - 10,
    radius: 105,
    color: [0.35, 0.92, 1.0],
    intensity: 1.05,
    flickerSpeed: 7.2,
    flickerAmp: 0.12,
    kind: 'homunculus',
  });
}

function pickDistinctDualStats(rng: RngAPI): ScrollStat[] {
  const firstIdx = rng.rangeInt(0, 2);
  const secondIdx = (firstIdx + rng.rangeInt(1, 2)) % 3;
  return [ALL_SCROLL_STATS[firstIdx]!, ALL_SCROLL_STATS[secondIdx]!];
}

function createPedestalStarterWeapon(state: SimState, defId: string): GearInstance {
  const def = getWeapon(defId);
  return {
    uid: state.nextUid++,
    defId: def.id,
    slotKind: 'weapon',
    level: 1,
    quality: 'base',
    color: def.colors[0] ?? 'brutality',
    affixes: [],
    ammo: def.ammoCapacity,
    maxAmmo: def.ammoCapacity,
    cooldownTicks: 0,
  };
}

function rollRecyclingTubeLoadout(
  state: SimState,
  rng: RngAPI,
  theme: ScrollStat
): {
  weapon1: GearInstance;
  weapon2: GearInstance;
  skill1: GearInstance;
  skill2: GearInstance;
  theme: ScrollStat;
} {
  const weapon1 = rollGearInstance(state, rng, 'weapon', 1, theme);
  let weapon2 = rollGearInstance(state, rng, 'weapon', 1, theme);
  for (let tries = 0; tries < 5 && weapon2.defId === weapon1.defId; tries++) {
    weapon2 = rollGearInstance(state, rng, 'weapon', 1, theme);
  }
  // Prefer pairing melee with shield/ranged on survival/tactics tubes when rolled identical
  if (weapon2.defId === weapon1.defId) {
    const fallbackId =
      theme === 'survival'
        ? 'StartShield'
        : theme === 'tactics'
          ? 'CloseCombatBow'
          : 'DualDaggers';
    if (WEAPON_MAP[fallbackId] && fallbackId !== weapon1.defId) {
      weapon2 = rollGearInstance(state, rng, 'weapon', 1, theme, false, fallbackId);
    }
  }

  const skill1 = rollGearInstance(state, rng, 'skill', 1, theme);
  let skill2 = rollGearInstance(state, rng, 'skill', 1, theme);
  for (let tries = 0; tries < 5 && skill2.defId === skill1.defId; tries++) {
    skill2 = rollGearInstance(state, rng, 'skill', 1, theme);
  }
  if (skill2.defId === skill1.defId) {
    const altId = skill1.defId === 'SinewSlicer' ? 'InfantryGrenade' : 'SinewSlicer';
    skill2 = rollGearInstance(state, rng, 'skill', 1, theme, false, altId);
  }

  return { weapon1, weapon2, skill1, skill2, theme };
}

function findSafeFloorTx(
  grid: TileGrid,
  col: CollisionAPI,
  r: RoomNode,
  preferredTx: number
): number {
  const floorTy = r.ty + r.th - 1;
  const minTx = r.tx + 2;
  const maxTx = r.tx + r.tw - 3;
  const clamped = Math.max(minTx, Math.min(maxTx, preferredTx));

  for (let offset = 0; offset <= maxTx - minTx; offset++) {
    for (const sign of offset === 0 ? [0] : [1, -1]) {
      const tx = clamped + offset * sign;
      if (tx < minTx || tx > maxTx) continue;
      const floorTile = col.getTile(grid, tx, floorTy);
      const above1 = col.getTile(grid, tx, floorTy - 1);
      const above2 = col.getTile(grid, tx, floorTy - 2);
      if (
        floorTile === TileKind.SOLID &&
        above1 !== TileKind.SOLID &&
        above1 !== TileKind.SPIKES &&
        above1 !== TileKind.ACID &&
        above2 !== TileKind.SOLID
      ) {
        return tx;
      }
    }
  }
  return clamped;
}

// =============================================================================
// Tile-Space BFS Reachability Verifier
// =============================================================================

function isTileSolidForBfs(grid: TileGrid, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return true;
  const k = grid.tiles[ty * grid.width + tx] as TileKindValue;
  return k === TileKind.SOLID || k === TileKind.SECRET_WALL || k === TileKind.CRACKED_FLOOR;
}

function isTilePassableForBfs(grid: TileGrid, tx: number, ty: number): boolean {
  if (tx < 1 || ty < 1 || tx >= grid.width - 1 || ty >= grid.height - 1) return false;
  if (isTileSolidForBfs(grid, tx, ty)) return false;
  if (isTileSolidForBfs(grid, tx, ty - 1)) return false;
  const k = grid.tiles[ty * grid.width + tx] as TileKindValue;
  if (k === TileKind.SPIKES || k === TileKind.ACID) return false;
  return true;
}

function isTileSupportedForBfs(grid: TileGrid, tx: number, ty: number): boolean {
  if (!isTilePassableForBfs(grid, tx, ty)) return false;
  const cur = grid.tiles[ty * grid.width + tx] as TileKindValue;
  const up = grid.tiles[(ty - 1) * grid.width + tx] as TileKindValue;
  if (cur === TileKind.LADDER || cur === TileKind.CHAIN || up === TileKind.LADDER || up === TileKind.CHAIN) {
    return true;
  }
  const below = grid.tiles[(ty + 1) * grid.width + tx] as TileKindValue;
  return (
    below === TileKind.SOLID ||
    below === TileKind.ONE_WAY ||
    below === TileKind.CRACKED_FLOOR ||
    below === TileKind.SECRET_WALL ||
    below === TileKind.LADDER ||
    below === TileKind.CHAIN
  );
}

function findNearestStandableTile(grid: TileGrid, startTx: number, startTy: number): [number, number] | null {
  for (let r = 0; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const tx = startTx + dx;
        const ty = startTy + dy;
        if (isTileSupportedForBfs(grid, tx, ty)) {
          return [tx, ty];
        }
      }
    }
  }
  return null;
}

function computeReachableTileMask(
  tileGrid: TileGrid,
  spawnPos: Vec2
): Uint8Array {
  const w = tileGrid.width;
  const h = tileGrid.height;
  const visited = new Uint8Array(w * h);

  const rawTx = Math.floor(spawnPos.x / TILE_SIZE);
  const rawTy = Math.floor((spawnPos.y + PLAYER_HEIGHT * 0.5 - 2) / TILE_SIZE);
  const start = findNearestStandableTile(tileGrid, rawTx, rawTy);
  if (!start) return visited;

  const queueX = new Int32Array(w * h);
  const queueY = new Int32Array(w * h);
  let head = 0;
  let tail = 0;

  const push = (tx: number, ty: number): void => {
    if (tx < 1 || ty < 1 || tx >= w - 1 || ty >= h - 1) return;
    const idx = ty * w + tx;
    if (visited[idx]) return;
    if (!isTileSupportedForBfs(tileGrid, tx, ty)) return;
    visited[idx] = 1;
    queueX[tail] = tx;
    queueY[tail] = ty;
    tail += 1;
  };

  push(start[0], start[1]);

  while (head < tail) {
    const cx = queueX[head]!;
    const cy = queueY[head]!;
    head += 1;

    const curTile = tileGrid.tiles[cy * w + cx] as TileKindValue;
    const belowTile = tileGrid.tiles[(cy + 1) * w + cx] as TileKindValue;

    // 1. Walk left/right + 1-tile step-up / auto-mantle
    for (const dir of [-1, 1] as const) {
      const nx = cx + dir;
      if (isTileSupportedForBfs(tileGrid, nx, cy)) {
        push(nx, cy);
      } else if (isTileSupportedForBfs(tileGrid, nx, cy - 1) && isTilePassableForBfs(tileGrid, cx, cy - 1)) {
        push(nx, cy - 1);
      }

      // Walk off edge and drop straight down to a lower supported tile
      if (isTilePassableForBfs(tileGrid, nx, cy)) {
        for (let fy = cy + 1; fy < h - 1; fy++) {
          if (!isTilePassableForBfs(tileGrid, nx, fy)) break;
          if (isTileSupportedForBfs(tileGrid, nx, fy)) {
            push(nx, fy);
            break;
          }
        }
      }
    }

    // 2. Climb up/down chains & ladders
    if (
      curTile === TileKind.LADDER ||
      curTile === TileKind.CHAIN ||
      belowTile === TileKind.LADDER ||
      belowTile === TileKind.CHAIN
    ) {
      if (isTileSupportedForBfs(tileGrid, cx, cy - 1)) push(cx, cy - 1);
      if (isTileSupportedForBfs(tileGrid, cx, cy + 1)) push(cx, cy + 1);
    }

    // 3. Drop through one-way platforms
    if (belowTile === TileKind.ONE_WAY) {
      for (let fy = cy + 1; fy < h - 1; fy++) {
        if (!isTilePassableForBfs(tileGrid, cx, fy)) break;
        if (isTileSupportedForBfs(tileGrid, cx, fy)) {
          push(cx, fy);
          break;
        }
      }
    }

    // 3b. Ram Rune Dive-Slam through CRACKED_FLOOR into secret sub-chambers
    if (belowTile === TileKind.CRACKED_FLOOR) {
      for (let fy = cy + 2; fy < h - 1; fy++) {
        const k = tileGrid.tiles[fy * w + cx] as TileKindValue;
        if (k === TileKind.SOLID || k === TileKind.SECRET_WALL) break;
        if (isTileSupportedForBfs(tileGrid, cx, fy)) {
          push(cx, fy);
          break;
        }
      }
    }

    // 4. Single + Double Jump arcs (up to 4 tiles vertically, 5 tiles horizontally)
    for (let dy = -4; dy <= 2; dy++) {
      for (let dx = -5; dx <= 5; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (Math.abs(dx) + Math.max(0, -dy) > 7) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue;
        if (visited[ny * w + nx]) continue;
        if (!isTileSupportedForBfs(tileGrid, nx, ny)) continue;

        // Verify simple clear arc (either rise-then-move or move-then-rise)
        const peakY = Math.min(cy, ny);
        let clearA = true;
        for (let y = cy; y >= peakY && clearA; y--) {
          if (!isTilePassableForBfs(tileGrid, cx, y)) clearA = false;
        }
        const stepX = dx >= 0 ? 1 : -1;
        for (let x = cx; x !== nx && clearA; x += stepX) {
          if (!isTilePassableForBfs(tileGrid, x + stepX, peakY)) clearA = false;
        }
        for (let y = peakY; y <= ny && clearA; y++) {
          if (!isTilePassableForBfs(tileGrid, nx, y)) clearA = false;
        }
        if (clearA) {
          push(nx, ny);
          continue;
        }

        let clearB = true;
        for (let x = cx; x !== nx && clearB; x += stepX) {
          if (!isTilePassableForBfs(tileGrid, x + stepX, cy)) clearB = false;
        }
        const yStep = ny >= cy ? 1 : -1;
        for (let y = cy; y !== ny && clearB; y += yStep) {
          if (!isTilePassableForBfs(tileGrid, nx, y + yStep)) clearB = false;
        }
        if (clearB) {
          push(nx, ny);
        }
      }
    }
  }

  return visited;
}

export function verifyWorldReachability(
  tileGrid: TileGrid,
  _rooms: RoomNode[],
  spawnPos: Vec2,
  targets: { label: string; pos: Vec2 }[]
): { reachable: boolean; missing: string[] } {
  const visited = computeReachableTileMask(tileGrid, spawnPos);
  const w = tileGrid.width;
  const h = tileGrid.height;
  const missing: string[] = [];

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    const ttx = Math.floor(t.pos.x / TILE_SIZE);
    const tty = Math.floor(t.pos.y / TILE_SIZE);

    let found = false;
    for (let dy = -2; dy <= 2 && !found; dy++) {
      for (let dx = -2; dx <= 2 && !found; dx++) {
        const cx = ttx + dx;
        const cy = tty + dy;
        if (cx >= 0 && cy >= 0 && cx < w && cy < h && visited[cy * w + cx]) {
          found = true;
        }
      }
    }
    if (!found) {
      missing.push(t.label);
    }
  }

  return { reachable: missing.length === 0, missing };
}

function carveEmergencyBridgeToTarget(
  tileGrid: TileGrid,
  col: CollisionAPI,
  visited: Uint8Array,
  targetPos: Vec2
): void {
  const w = tileGrid.width;
  const h = tileGrid.height;
  const ttx = Math.max(2, Math.min(w - 3, Math.floor(targetPos.x / TILE_SIZE)));
  const tty = Math.max(2, Math.min(h - 3, Math.floor(targetPos.y / TILE_SIZE)));

  // Find closest reachable tile
  let bestX = -1;
  let bestY = -1;
  let bestDist = Infinity;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!visited[y * w + x]) continue;
      const d = Math.abs(x - ttx) + Math.abs(y - tty);
      if (d < bestDist) {
        bestDist = d;
        bestX = x;
        bestY = y;
      }
    }
  }
  if (bestX < 0) return;

  // Carve a clean 3-tile high horizontal tunnel + vertical chain shaft
  const xStart = Math.min(bestX, ttx);
  const xEnd = Math.max(bestX, ttx);
  for (let x = xStart; x <= xEnd; x++) {
    for (let dy = -2; dy <= 0; dy++) {
      col.setTile(tileGrid, x, bestY + dy, TileKind.EMPTY);
    }
    if (col.getTile(tileGrid, x, bestY + 1) === TileKind.EMPTY) {
      col.setTile(tileGrid, x, bestY + 1, TileKind.ONE_WAY);
    }
  }

  const yStart = Math.min(bestY, tty);
  const yEnd = Math.max(bestY, tty);
  for (let y = yStart - 1; y <= yEnd; y++) {
    col.setTile(tileGrid, ttx - 1, y, TileKind.EMPTY);
    col.setTile(tileGrid, ttx, y, TileKind.CHAIN);
    col.setTile(tileGrid, ttx + 1, y, TileKind.EMPTY);
  }
  if (col.getTile(tileGrid, ttx, tty + 1) === TileKind.EMPTY) {
    col.setTile(tileGrid, ttx, tty + 1, TileKind.ONE_WAY);
  }
}

// =============================================================================
// Boss Arena Generator (Bridge, TopClockTower, Throne)
// =============================================================================

function generateBossArena(
  state: SimState,
  biome: BiomeDef,
  rng: RngAPI,
  col: CollisionAPI
): void {
  const width = 44;
  const height = 18;
  const grid = createEmptyGrid(width, height);
  const floorTy = 14;
  const floorSurfaceY = floorTy * TILE_SIZE;

  // Carve dramatic wide gothic hall (tx: 2..41, ty: 2..13)
  fillTileRect(grid, col, 2, 2, width - 4, floorTy - 2, TileKind.EMPTY);
  carveRoomBackground(grid, biome.id, 2, 2, width - 4, floorTy - 2, floorTy);

  // Authentic Dead Cells Arenas:
  // - Black Bridge (Concierge) & Clock Room (Time Keeper): NO floating cheese balconies!
  // - Throne Room (Hand of the King): side temporary destructible Ice Platforms (tx: 6..10 & 33..37, ty: 10)
  //   plus recessed left & right spike pits (tx: 2..4 & 39..41).
  if (biome.id === 'Throne') {
    fillTileRect(grid, col, 6, 10, 5, 1, TileKind.ONE_WAY);
    fillTileRect(grid, col, 33, 10, 5, 1, TileKind.ONE_WAY);
    fillTileRect(grid, col, 2, floorTy, 3, 1, TileKind.SPIKES);
    fillTileRect(grid, col, 39, floorTy, 3, 1, TileKind.SPIKES);
  }

  // Mark entire arena explored for crisp minimap & lighting
  grid.explored.fill(1);
  state.tileGrid = grid;

  const arenaRoom: RoomNode = {
    id: 0,
    type: 'bossArena',
    tx: 2,
    ty: 2,
    tw: width - 4,
    th: floorTy - 1,
    neighbors: [],
    discovered: true,
    cleared: false,
  };
  state.rooms = [arenaRoom];

  // Atmospheric grounded floor braziers lighting the arena!
  const primaryLight = hexToRgb01(biome.lightColors[0] ?? '#ff9d42');
  const accentLight = hexToRgb01(biome.lightColors[1] ?? '#ffd166');
  for (let tx = 7; tx <= 35; tx += 7) {
    const isAccent = (tx / 7) % 2 === 0;
    addWorldLight(
      state,
      tx * TILE_SIZE + 12,
      floorSurfaceY - 18,
      145,
      isAccent ? accentLight : primaryLight,
      1.1,
      'brazier',
      4.5 + (tx % 3),
      0.16
    );
  }

  // Entrance & Exit Boss Gates (grounded cleanly on solid stone!)
  const entranceGateTx = biome.id === 'Throne' ? 6 : 4;
  state.doors.push({
    uid: state.nextUid++,
    pos: { x: entranceGateTx * TILE_SIZE, y: floorSurfaceY - 24 },
    width: 22,
    height: 48,
    kind: 'bossGate',
    opened: true, // Slams shut upon crossing the boss engagement threshold!
    broken: false,
    label: 'Boss Arena Gate',
  });

  if (biome.nextBiomes.length > 0) {
    for (let i = 0; i < biome.nextBiomes.length; i++) {
      const targetId = biome.nextBiomes[i]!;
      const targetDef = getBiome(targetId);
      const doorX = (36 - i * 3) * TILE_SIZE;
      state.doors.push({
        uid: state.nextUid++,
        pos: { x: doorX, y: floorSurfaceY - 24 },
        width: 28,
        height: 48,
        kind: 'biomeExit',
        opened: false,
        broken: false,
        targetBiomeId: targetId,
        label: `Passage to ${targetDef.name}`,
      });
      addWorldLight(state, doorX, floorSurfaceY - 26, 95, [0.3, 0.95, 0.6], 0.9, 'portal');
    }
  } else if (biome.id === 'Throne') {
    // Celebratory Sovereign Throne interactable
    state.shrines.push({
      uid: state.nextUid++,
      pos: { x: 34 * TILE_SIZE, y: floorSurfaceY },
      kind: 'loreSkeleton',
      used: false,
      label: 'Claim the Sovereign Throne',
    });
  }

  // Place player safely on left arena floor
  state.player.pos = { x: 10 * TILE_SIZE, y: floorSurfaceY - PLAYER_HEIGHT * 0.5 };
  state.player.prevPos = { ...state.player.pos };
  state.player.vel = { x: 0, y: 0 };
  state.player.facing = 1;
  state.player.grounded = true;
  state.player.onOneWay = false;
  state.player.diveSlamState = 'none';
  state.player.fallStartY = state.player.pos.y;
  state.player.fallStunTicks = 0;
  state.player.airJumpsLeft = state.player.maxAirJumps;

  // Spawn the biome's Boss on-screen in dramatic standoff framing!
  const bossId = biome.bossId ?? 'Behemoth';
  const bossDef = getBoss(bossId);
  const bossX = 22 * TILE_SIZE;
  const bossY = floorSurfaceY - bossDef.height * 0.5;
  const boss = spawnBoss(state, bossId, bossX, bossY);
  boss.state = 'idle';

  // Add subtle boss aura light (balanced so boss steel/armor shading never blows out!)
  addWorldLight(state, bossX, bossY - 12, 145, primaryLight, 0.82, 'boss', 6.0, 0.16);

  // Keep lockedLeftX/lockedRightX inside spike pit margins on Throne or walls elsewhere
  state.bossArenaState.lockedLeftX = 2 * TILE_SIZE + 8;
  state.bossArenaState.lockedRightX = (width - 2) * TILE_SIZE - 8;
  // Boss remains poised until player crosses x >= 14 * TILE_SIZE or deals damage!
  state.bossArenaState.engaged = false;
  state.bossArenaState.playerTookHit = false;
  state.bossArenaState.bannerTicks = 0;
  if (biome.id === 'Throne') {
    state.bossArenaState.icePlatformTimers = [0, 0];
  }

  // Ensure homunculus flame light is present
  ensureHomunculusLight(state);
  void rng;
}

// =============================================================================
// Passage Safe Room Generator (52 × 16 tiles)
// =============================================================================

function generatePassageSafeRoom(
  state: SimState,
  rng: RngAPI,
  col: CollisionAPI
): void {
  const width = 52;
  const height = 16;
  const grid = createEmptyGrid(width, height);
  const floorTy = 12;

  // Carve warm stone gallery (tx: 2..49, ty: 2..11) + arched sanctuary windows
  fillTileRect(grid, col, 2, 2, width - 4, floorTy - 2, TileKind.EMPTY);
  carveRoomBackground(grid, 'Passage', 2, 2, width - 4, floorTy - 2, floorTy);
  // Decorative loft platform near left ceiling
  fillTileRect(grid, col, 6, 8, 8, 1, TileKind.ONE_WAY);

  grid.explored.fill(1);
  state.tileGrid = grid;

  const passageRoom: RoomNode = {
    id: 0,
    type: 'passage',
    tx: 2,
    ty: 2,
    tw: 48,
    th: 12,
    neighbors: [],
    discovered: true,
    cleared: true,
  };
  state.rooms = [passageRoom];

  const fromBiome: BiomeId =
    state.passageState.fromBiome && state.passageState.fromBiome !== 'Passage'
      ? state.passageState.fromBiome
      : 'PrisonStart';
  const fromDef = getBiome(fromBiome);
  const nextBiomes: BiomeId[] =
    state.passageState.nextBiomes.length > 0
      ? [...state.passageState.nextBiomes]
      : fromDef.nextBiomes.length > 0
        ? [...fromDef.nextBiomes]
        : ['PrisonCourtyard'];

  // Delegate NPC shrines, Timed/KillStreak doors & Exit doors to passage.ts
  enterPassageRoom(state, fromBiome, nextBiomes, rng);

  const floorY = (passageRoom.ty + passageRoom.th - 2) * TILE_SIZE;
  const baseX = (passageRoom.tx + 4) * TILE_SIZE;

  // Position player safely at entrance of the Passage safe room
  state.player.pos = { x: baseX + 12, y: floorY - PLAYER_HEIGHT * 0.5 };
  state.player.prevPos = { ...state.player.pos };
  state.player.vel = { x: 0, y: 0 };
  state.player.facing = 1;
  state.player.grounded = true;
  state.player.onOneWay = false;
  state.player.diveSlamState = 'none';
  state.player.fallStartY = state.player.pos.y;
  state.player.fallStunTicks = 0;

  // Cozy Passage lighting (warm amber torches + cyan Collector + emerald Fountain)
  state.lights = [];
  for (let tx = 4; tx <= 46; tx += 6) {
    addWorldLight(
      state,
      tx * TILE_SIZE + 12,
      (floorTy - 3) * TILE_SIZE,
      135,
      [1.0, 0.68, 0.34],
      1.15,
      'torch',
      4.5,
      0.14
    );
  }
  for (let i = 0; i < state.shrines.length; i++) {
    const sh = state.shrines[i]!;
    const color: [number, number, number] =
      sh.kind === 'collector'
        ? [0.32, 0.9, 1.0]
        : sh.kind === 'fountain'
          ? [0.3, 1.0, 0.62]
          : sh.kind === 'guillain'
            ? [0.76, 0.48, 1.0]
            : [1.0, 0.55, 0.25];
    addWorldLight(state, sh.pos.x, sh.pos.y - 24, 105, color, 1.0, 'portal', 3.5, 0.1);
  }
  ensureHomunculusLight(state);
}

// =============================================================================
// Secret CRACKED_FLOOR 6x3 Sub-Chamber Carvers
// =============================================================================

function carveSecretCellar(
  state: SimState,
  grid: TileGrid,
  col: CollisionAPI,
  biome: BiomeDef,
  r: RoomNode,
  innerTx: number,
  floorTy: number,
  rng: RngAPI,
  reachTargets: { label: string; pos: Vec2 }[]
): boolean {
  // Need solid bedrock at floorTy + 4 and margin inside grid bounds
  if (floorTy + 5 >= grid.height) return false;

  const cellarTx = innerTx + 2;
  const cellarW = 6;
  const cellarH = 3;
  const cellarFloorTy = floorTy + cellarH + 1;

  // Carve 6x3 sub-chamber beneath floorTy (floorTy + 1 .. floorTy + 3)
  fillTileRect(grid, col, cellarTx, floorTy + 1, cellarW, cellarH, TileKind.EMPTY);
  // Ensure solid enclosing walls and floor around the cellar
  for (let y = floorTy + 1; y <= cellarFloorTy; y++) {
    col.setTile(grid, cellarTx - 1, y, TileKind.SOLID);
    col.setTile(grid, cellarTx + cellarW, y, TileKind.SOLID);
  }
  for (let x = cellarTx - 1; x <= cellarTx + cellarW; x++) {
    col.setTile(grid, x, cellarFloorTy, TileKind.SOLID);
  }

  // Place 2-tile breakable CRACKED_FLOOR entry roof (Ram Rune target!)
  col.setTile(grid, cellarTx + 1, floorTy, TileKind.CRACKED_FLOOR);
  col.setTile(grid, cellarTx + 2, floorTy, TileKind.CRACKED_FLOOR);

  // Escape chain directly beneath the left cracked tile + helper ledge so player climbs cleanly out!
  for (let y = floorTy + 1; y <= floorTy + cellarH; y++) {
    col.setTile(grid, cellarTx + 1, y, TileKind.CHAIN);
  }
  col.setTile(grid, cellarTx + 3, floorTy + 2, TileKind.ONE_WAY);

  // Warm subterranean torch lighting
  const cellarFloorY = cellarFloorTy * TILE_SIZE;
  addWorldLight(
    state,
    (cellarTx + 3) * TILE_SIZE,
    (floorTy + 2) * TILE_SIZE,
    94,
    [1.0, 0.72, 0.34],
    0.98,
    'torch',
    5.0,
    0.16
  );

  const lootX = (cellarTx + 4.5) * TILE_SIZE;
  const lootY = cellarFloorY - 12;

  if (rng.chance(0.5)) {
    state.chests.push({
      uid: state.nextUid++,
      pos: { x: lootX, y: lootY },
      kind: 'treasure',
      opened: false,
      roomId: r.id,
    });
    addWorldLight(state, lootX, lootY - 8, 80, [1.0, 0.85, 0.35], 0.95, 'scroll');
    reachTargets.push({ label: `cellar:chest_${r.id}`, pos: { x: lootX, y: lootY } });
  } else {
    state.pickups.push(
      {
        uid: state.nextUid++,
        kind: 'gold',
        pos: { x: lootX - 10, y: lootY },
        prevPos: { x: lootX - 10, y: lootY },
        vel: { x: 0, y: 0 },
        value: 250 + biome.depthTier * 60,
        label: 'Cellar Gold Gem',
        magnetTicks: 0,
        collected: false,
        bobPhase: 0.4,
      },
      {
        uid: state.nextUid++,
        kind: 'food',
        pos: { x: lootX + 10, y: lootY },
        prevPos: { x: lootX + 10, y: lootY },
        vel: { x: 0, y: 0 },
        value: 50,
        label: 'Cellar Roast (+50% HP)',
        magnetTicks: 0,
        collected: false,
        bobPhase: 1.5,
      }
    );
    reachTargets.push({ label: `cellar:loot_${r.id}`, pos: { x: lootX, y: lootY } });
  }

  return true;
}

// =============================================================================
// Regular Metroidvania Biome Generator (10–17 Interconnected Rooms)
// =============================================================================

interface PlacedCell {
  id: number;
  gx: number;
  gy: number;
  neighbors: number[];
  depth: number;
}

function generateRegularBiome(
  state: SimState,
  biome: BiomeDef,
  rng: RngAPI,
  col: CollisionAPI
): void {
  const profile = getBiomeLayoutProfile(biome.id);
  const { gridCols, gridRows, cellW, cellH, startGx, startGy, dirs } = profile;

  const minRooms = Math.max(10, biome.roomCountRange[0]);
  const maxRooms = Math.min(gridCols * gridRows - 2, Math.max(minRooms, biome.roomCountRange[1]));
  const targetRooms = rng.rangeInt(minRooms, maxRooms);

  const worldW = gridCols * cellW + GRID_PAD_X * 2;
  const worldH = gridRows * cellH + GRID_PAD_Y + GRID_PAD_Y_BOTTOM;
  const grid = createEmptyGrid(worldW, worldH);

  // 1. Build connected branching Metroidvania cell graph
  const cellMap = new Map<string, PlacedCell>();
  const cells: PlacedCell[] = [];
  const keyOf = (gx: number, gy: number) => `${gx},${gy}`;

  const addCell = (gx: number, gy: number, depth: number): PlacedCell => {
    const cell: PlacedCell = { id: cells.length, gx, gy, neighbors: [], depth };
    cells.push(cell);
    cellMap.set(keyOf(gx, gy), cell);
    return cell;
  };

  const connectCells = (a: PlacedCell, b: PlacedCell): void => {
    if (!a.neighbors.includes(b.id)) a.neighbors.push(b.id);
    if (!b.neighbors.includes(a.id)) b.neighbors.push(a.id);
  };

  addCell(startGx, startGy, 0);

  // Biome-specific signature macro spines before branching!
  if (biome.id === 'PrisonCourtyard') {
    // Promenade surface open-sky boulevard spine along gy = 1
    let prev = cells[0]!;
    for (let gx = 1; gx <= Math.min(4, gridCols - 1) && cells.length < targetRooms; gx++) {
      const next = addCell(gx, startGy, prev.depth + 1);
      connectCells(prev, next);
      prev = next;
    }
  } else if (biome.id === 'ClockTower') {
    // Vertical ascent spine climbing UP from (1, 5) toward top of the tower
    let prev = cells[0]!;
    for (let gy = startGy - 1; gy >= 0 && cells.length < targetRooms; gy--) {
      const shiftX = rng.chance(0.4) ? (prev.gx === 1 ? 2 : 1) : prev.gx;
      if (shiftX !== prev.gx && !cellMap.has(keyOf(shiftX, prev.gy))) {
        const horiz = addCell(shiftX, prev.gy, prev.depth + 1);
        connectCells(prev, horiz);
        prev = horiz;
      }
      if (!cellMap.has(keyOf(prev.gx, gy)) && cells.length < targetRooms) {
        const up = addCell(prev.gx, gy, prev.depth + 1);
        connectCells(prev, up);
        prev = up;
      }
    }
  }

  let attempts = 0;
  while (cells.length < targetRooms && attempts < 500) {
    attempts += 1;
    // Prefer expanding from recent or frontier nodes
    const pickIdx = rng.chance(0.65)
      ? Math.max(0, cells.length - 1 - rng.rangeInt(0, Math.min(3, cells.length - 1)))
      : rng.rangeInt(0, cells.length - 1);
    const base = cells[pickIdx]!;
    const [dx, dy] = rng.pick(dirs);
    const nx = base.gx + dx;
    const ny = base.gy + dy;
    if (nx < 0 || ny < 0 || nx >= gridCols || ny >= gridRows) continue;
    if (cellMap.has(keyOf(nx, ny))) continue;

    const child = addCell(nx, ny, base.depth + 1);
    connectCells(base, child);
  }

  // Add 2–3 Metroidvania loop edges between adjacent placed cells
  let loopsAdded = 0;
  for (let i = 0; i < cells.length && loopsAdded < 3; i++) {
    const a = cells[i]!;
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
    ] as const) {
      const b = cellMap.get(keyOf(a.gx + dx, a.gy + dy));
      if (b && !a.neighbors.includes(b.id) && rng.chance(0.45)) {
        connectCells(a, b);
        loopsAdded += 1;
        break;
      }
    }
  }

  // 2. Assign RoomTypes cleanly
  const roomTypes: RoomType[] = new Array(cells.length).fill('corridor');
  const exitBiomeMap = new Map<number, BiomeId>();
  roomTypes[0] = 'entrance';

  // Sort non-entrance rooms by biome exit bias (ClockTower prioritizes top-most rooms!)
  const nonStartIds = cells
    .slice(1)
    .sort((a, b) =>
      biome.id === 'ClockTower'
        ? a.gy - b.gy || b.depth - a.depth
        : b.depth - a.depth || b.gx - a.gx
    )
    .map((c) => c.id);

  const usedSpecial = new Set<number>([0]);

  // Assign an Exit room for EVERY nextBiome
  const nextBiomes = biome.nextBiomes.length > 0 ? biome.nextBiomes : (['PrisonCourtyard'] as BiomeId[]);
  for (let i = 0; i < nextBiomes.length && i < nonStartIds.length; i++) {
    const rid = nonStartIds[i]!;
    roomTypes[rid] = 'exit';
    exitBiomeMap.set(rid, nextBiomes[i]!);
    usedSpecial.add(rid);
  }

  const pickFreeRoom = (preferMid = false, filterFn?: (id: number) => boolean): number | null => {
    const basePool = nonStartIds.filter((id) => !usedSpecial.has(id));
    const pool = filterFn ? basePool.filter(filterFn) : basePool;
    const finalPool = pool.length > 0 ? pool : basePool;
    if (finalPool.length === 0) return null;
    const chosen = preferMid ? finalPool[Math.floor(finalPool.length * 0.5)]! : rng.pick(finalPool);
    usedSpecial.add(chosen);
    return chosen;
  };

  // Treasure Room (prefer rooms with no cell below so CRACKED_FLOOR cellar can carve underneath!)
  const treasureId = pickFreeRoom(false, (id) => {
    const c = cells[id]!;
    return !cellMap.has(keyOf(c.gx, c.gy + 1));
  });
  if (treasureId !== null) roomTypes[treasureId] = 'treasure';

  // Weapon or Skill Merchant Shop
  const shopRoomId = pickFreeRoom(true);
  if (shopRoomId !== null) roomTypes[shopRoomId] = rng.chance(0.55) ? 'weaponShop' : 'skillShop';

  // Cursed Chest Room
  const cursedId = pickFreeRoom(false);
  if (cursedId !== null) roomTypes[cursedId] = 'cursedChest';

  // Challenge Rift Room (prefer a leaf/side room without vertical bottom shaft for clean obstacle corridor!)
  const riftId = pickFreeRoom(false, (id) => {
    const c = cells[id]!;
    return !c.neighbors.some((nid) => cells[nid]!.gy > c.gy);
  });
  if (riftId !== null) roomTypes[riftId] = 'challengeRift';

  // Food Shop (when >= 11 rooms)
  if (cells.length >= 11) {
    const foodId = pickFreeRoom(true);
    if (foodId !== null) roomTypes[foodId] = 'foodShop';
  }

  // Dedicated Teleporter Shrine rooms (1–2 extra)
  const tpRoom1 = pickFreeRoom(true);
  if (tpRoom1 !== null) roomTypes[tpRoom1] = 'teleporter';
  if (cells.length >= 13) {
    const tpRoom2 = pickFreeRoom(false);
    if (tpRoom2 !== null) roomTypes[tpRoom2] = 'teleporter';
  }

  // Remaining rooms: verticalShaft if vertically connected, else combatArena / corridor
  for (let i = 1; i < cells.length; i++) {
    if (usedSpecial.has(i)) continue;
    const c = cells[i]!;
    const hasVertical = c.neighbors.some((nid) => cells[nid]!.gy !== c.gy);
    if (hasVertical && rng.chance(biome.id === 'ClockTower' ? 0.8 : 0.65)) {
      roomTypes[i] = 'verticalShaft';
    } else if (rng.chance(0.55)) {
      roomTypes[i] = 'combatArena';
    } else {
      roomTypes[i] = 'corridor';
    }
  }

  // 3. Create RoomNode structs & carve room interiors
  const rooms: RoomNode[] = cells.map((c) => {
    const tx = GRID_PAD_X + c.gx * cellW + 1;
    const ty = GRID_PAD_Y + c.gy * cellH + 1;
    const tw = cellW - 2;
    const th = cellH - 2;
    const type = roomTypes[c.id]!;
    const shopKind =
      type === 'weaponShop'
        ? 'weapon'
        : type === 'skillShop'
          ? 'skill'
          : type === 'foodShop'
            ? 'food'
            : undefined;
    return {
      id: c.id,
      type,
      tx,
      ty,
      tw,
      th,
      neighbors: [...c.neighbors],
      discovered: c.id === 0,
      cleared:
        type === 'entrance' ||
        type === 'exit' ||
        type === 'treasure' ||
        type === 'teleporter' ||
        type === 'challengeRift' ||
        Boolean(shopKind),
      exitBiomeId: exitBiomeMap.get(c.id),
      shopKind,
    };
  });

  // Track mandatory reachable targets for BFS verification
  const reachTargets: { label: string; pos: Vec2 }[] = [];

  // Carve each room interior + biome-distinct architecture + secret cellars
  const primaryLight = hexToRgb01(biome.lightColors[0] ?? '#ff9d42');
  const secondaryLight = hexToRgb01(biome.lightColors[1] ?? '#ffd27d');
  const accentLight = hexToRgb01(biome.lightColors[2] ?? '#5fd6ff');

  let sewerBonusCellars = 0;

  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i]!;
    const cell = cells[r.id]!;
    const innerTx = r.tx + 1;
    const innerTw = r.tw - 2;
    const floorTy = r.ty + r.th - 1;
    const baseInnerTh = r.th - 2;
    const innerTh =
      profile.innerHOverride !== undefined && r.type !== 'challengeRift'
        ? Math.min(baseInnerTh, profile.innerHOverride)
        : baseInnerTh;
    const innerTy = floorTy - innerTh;

    fillTileRect(grid, col, innerTx, innerTy, innerTw, innerTh, TileKind.EMPTY);
    carveRoomBackground(grid, biome.id, innerTx, innerTy, innerTw, innerTh, floorTy);

    const hasBottomNeighbor = r.neighbors.some((nid) => cells[nid]!.gy > cell.gy);
    const hasTopNeighbor = r.neighbors.some((nid) => cells[nid]!.gy < cell.gy);
    const hasCellDirectlyBelow = cellMap.has(keyOf(cell.gx, cell.gy + 1));

    // Special room: Challenge Rift Trap Gauntlet (alternating spikes + elevated one-way stepping stones!)
    if (r.type === 'challengeRift') {
      const shaftTx = r.tx + Math.floor(r.tw * 0.5);
      const nearShaft = (tx: number): boolean =>
        (hasBottomNeighbor || hasTopNeighbor) && Math.abs(tx - shaftTx) <= 2;

      // Carve 3 spike pit zones across the central corridor, leaving safe solid pads at both ends
      const segs: readonly [number, number, number][] = [
        [innerTx + 3, innerTx + 5, floorTy - 2],
        [innerTx + 7, innerTx + 9, floorTy - 3],
        [innerTx + 11, innerTx + Math.min(innerTw - 4, 13), floorTy - 2],
      ];
      for (const [sStart, sEnd, platTy] of segs) {
        if (sEnd <= sStart) continue;
        for (let sx = sStart; sx <= sEnd; sx++) {
          if (!nearShaft(sx)) {
            col.setTile(grid, sx, floorTy, TileKind.SPIKES);
          }
          col.setTile(grid, sx, platTy, TileKind.ONE_WAY);
        }
        // Extend stepping stone 1 tile onto safe pillar for generous footing
        if (sStart - 1 > innerTx + 1) {
          col.setTile(grid, sStart - 1, platTy, TileKind.ONE_WAY);
        }
      }
      // Subtle crimson rift glow along gauntlet floor
      addWorldLight(
        state,
        (innerTx + Math.floor(innerTw * 0.5)) * TILE_SIZE,
        (floorTy - 2) * TILE_SIZE,
        135,
        [0.95, 0.25, 0.42],
        1.1,
        'portal',
        5.5,
        0.18
      );
      continue;
    }

    // One-way platform tiers (customized per biome silhouette!)
    if (r.type === 'combatArena' || r.type === 'corridor' || r.type === 'verticalShaft') {
      if (biome.id === 'Sewer') {
        // Cramped low catwalk shelf in flooded tunnels
        fillTileRect(grid, col, innerTx + 3, floorTy - 2, 4, 1, TileKind.ONE_WAY);
        fillTileRect(grid, col, innerTx + innerTw - 7, floorTy - 2, 4, 1, TileKind.ONE_WAY);
      } else if (biome.id === 'ClockTower') {
        // Staggered clockwork stepping gears for vertical momentum
        fillTileRect(grid, col, innerTx + 2, floorTy - 3, 5, 1, TileKind.ONE_WAY);
        fillTileRect(grid, col, innerTx + innerTw - 7, floorTy - 3, 5, 1, TileKind.ONE_WAY);
        fillTileRect(grid, col, innerTx + 5, floorTy - 5, Math.max(4, innerTw - 10), 1, TileKind.ONE_WAY);
      } else if (biome.id === 'Castle') {
        // Grand elevated royal galleries
        fillTileRect(grid, col, innerTx + 2, floorTy - 3, 5, 1, TileKind.ONE_WAY);
        fillTileRect(grid, col, innerTx + innerTw - 7, floorTy - 3, 5, 1, TileKind.ONE_WAY);
        fillTileRect(grid, col, innerTx + 5, floorTy - 6, Math.max(5, innerTw - 10), 1, TileKind.ONE_WAY);
      } else {
        fillTileRect(grid, col, innerTx + 2, floorTy - 3, 5, 1, TileKind.ONE_WAY);
        fillTileRect(grid, col, innerTx + innerTw - 7, floorTy - 3, 5, 1, TileKind.ONE_WAY);
        if (r.type === 'combatArena' || r.type === 'verticalShaft') {
          fillTileRect(grid, col, innerTx + 6, floorTy - 6, Math.max(4, innerTw - 12), 1, TileKind.ONE_WAY);
        }
      }
    } else if (r.type === 'entrance' || r.type === 'treasure' || r.type === 'cursedChest') {
      if (biome.id !== 'Sewer') {
        fillTileRect(grid, col, innerTx + 3, floorTy - 3, 4, 1, TileKind.ONE_WAY);
        fillTileRect(grid, col, innerTx + innerTw - 7, floorTy - 3, 4, 1, TileKind.ONE_WAY);
      }
    }

    // Optional jumpable hazard pit (2 tiles wide) in combat rooms ONLY (never near doorways/shafts)
    if (
      !hasBottomNeighbor &&
      (r.type === 'combatArena' || r.type === 'corridor') &&
      (biome.hasAcid || (biome.depthTier >= 2 && rng.chance(0.45)))
    ) {
      const pitTx = innerTx + Math.max(6, Math.floor(innerTw * 0.45));
      const hazardKind = biome.hasAcid ? TileKind.ACID : TileKind.SPIKES;
      col.setTile(grid, pitTx, floorTy, hazardKind);
      col.setTile(grid, pitTx + 1, floorTy, hazardKind);
      // Safe one-way bridge above pit so both jumping and traversal stay effortless
      col.setTile(grid, pitTx - 1, floorTy - 2, TileKind.ONE_WAY);
      col.setTile(grid, pitTx, floorTy - 2, TileKind.ONE_WAY);
      col.setTile(grid, pitTx + 1, floorTy - 2, TileKind.ONE_WAY);
      col.setTile(grid, pitTx + 2, floorTy - 2, TileKind.ONE_WAY);

      if (hazardKind === TileKind.ACID) {
        addWorldLight(
          state,
          (pitTx + 1) * TILE_SIZE,
          floorTy * TILE_SIZE,
          82,
          [0.42, 0.96, 0.28],
          0.85,
          'acid',
          3.2,
          0.1
        );
      }
    }

    // Shallow water puddles in Sewer & StiltVillage (enables Electric Whip water conductivity!)
    if (
      !hasBottomNeighbor &&
      (biome.id === 'Sewer' || biome.id === 'StiltVillage' || biome.id === 'PrisonCourtyard') &&
      (r.type === 'corridor' || r.type === 'combatArena') &&
      rng.chance(biome.id === 'Sewer' ? 0.5 : 0.25)
    ) {
      const waterTx = innerTx + 2;
      if (col.getTile(grid, waterTx, floorTy) === TileKind.SOLID) {
        col.setTile(grid, waterTx, floorTy - 1, TileKind.WATER);
        col.setTile(grid, waterTx + 1, floorTy - 1, TileKind.WATER);
      }
    }

    // Occasional breakable secret wall alcove on solid side edge (when no neighbor on that side)
    const hasRightNeighbor = r.neighbors.some((nid) => cells[nid]!.gx > cell.gx);
    if (!hasRightNeighbor && (r.type === 'corridor' || r.type === 'combatArena') && rng.chance(0.3)) {
      col.setTile(grid, r.tx + r.tw - 1, floorTy - 1, TileKind.SECRET_WALL);
      col.setTile(grid, r.tx + r.tw - 1, floorTy - 2, TileKind.SECRET_WALL);
    }

    // Authentic CRACKED_FLOOR secret 6x3 sub-chamber beneath treasure rooms (and Sewer tunnels!)
    const wantsCellar =
      !hasBottomNeighbor &&
      !hasCellDirectlyBelow &&
      ((r.type === 'treasure' && rng.chance(0.85)) ||
        (biome.id === 'Sewer' &&
          sewerBonusCellars < 2 &&
          (r.type === 'corridor' || r.type === 'combatArena') &&
          rng.chance(0.45)));
    if (wantsCellar) {
      if (carveSecretCellar(state, grid, col, biome, r, innerTx, floorTy, rng, reachTargets)) {
        if (biome.id === 'Sewer' && r.type !== 'treasure') {
          sewerBonusCellars += 1;
        }
      }
    }

    // Atmospheric wall torches + grounded floor braziers!
    const torchY = (floorTy - Math.min(3, Math.max(2, innerTh - 1))) * TILE_SIZE;
    const brazierY = floorTy * TILE_SIZE - 18;
    const lColor = i % 3 === 0 ? primaryLight : i % 3 === 1 ? secondaryLight : accentLight;
    addWorldLight(state, (innerTx + 3) * TILE_SIZE, torchY, 132, lColor, 1.0, 'torch', 4.6, 0.14);
    addWorldLight(
      state,
      (innerTx + innerTw - 4) * TILE_SIZE,
      brazierY,
      138,
      i % 2 === 0 ? primaryLight : secondaryLight,
      1.05,
      'brazier',
      5.2,
      0.16
    );
  }

  // 4. Carve doorways, biome-distinct merged wide halls & vertical chain/ladder shafts
  const carvedEdges = new Set<string>();
  const climbKind: TileKindValue =
    biome.id === 'PrisonCourtyard' || biome.id === 'StiltVillage' ? TileKind.LADDER : TileKind.CHAIN;
  const mergedCastlePairs = new Set<number>();

  for (let i = 0; i < cells.length; i++) {
    const a = cells[i]!;
    const roomA = rooms[a.id]!;
    for (let j = 0; j < a.neighbors.length; j++) {
      const nid = a.neighbors[j]!;
      const edgeKey = a.id < nid ? `${a.id}-${nid}` : `${nid}-${a.id}`;
      if (carvedEdges.has(edgeKey)) continue;
      carvedEdges.add(edgeKey);

      const b = cells[nid]!;
      const roomB = rooms[b.id]!;

      if (a.gy === b.gy) {
        const leftRoom = a.gx < b.gx ? roomA : roomB;
        const rightRoom = a.gx < b.gx ? roomB : roomA;
        const floorTy = leftRoom.ty + leftRoom.th - 1;
        const xFrom = leftRoom.tx + leftRoom.tw - 1;
        const xTo = rightRoom.tx;

        // Biome-distinct merged grand spaces:
        // - PrisonCourtyard (Promenade): open-sky surface boulevard along gy === 1!
        // - Castle: grand double-wide royal halls (2x1 merged combat/corridor pairs)!
        const isPromenadeBoulevard =
          biome.id === 'PrisonCourtyard' &&
          a.gy === 1 &&
          leftRoom.type !== 'challengeRift' &&
          rightRoom.type !== 'challengeRift' &&
          leftRoom.type !== 'exit' &&
          rightRoom.type !== 'exit';

        const isCastleRoyalHall =
          biome.id === 'Castle' &&
          !mergedCastlePairs.has(leftRoom.id) &&
          !mergedCastlePairs.has(rightRoom.id) &&
          (leftRoom.type === 'combatArena' || leftRoom.type === 'corridor') &&
          (rightRoom.type === 'combatArena' || rightRoom.type === 'corridor');

        const isRampartBridge =
          biome.id === 'PrisonRoof' &&
          a.gy <= 1 &&
          leftRoom.type !== 'challengeRift' &&
          rightRoom.type !== 'challengeRift';

        if (isPromenadeBoulevard || isCastleRoyalHall || isRampartBridge) {
          const openH = leftRoom.th - 2;
          const openTopTy = floorTy - openH;
          fillTileRect(grid, col, xFrom, openTopTy, xTo - xFrom + 1, openH, TileKind.EMPTY);
          if (OUTDOOR_BIOMES.has(biome.id)) {
            carveRoomBackground(grid, biome.id, xFrom, openTopTy, xTo - xFrom + 1, openH, floorTy);
          }
          for (let x = xFrom; x <= xTo; x++) {
            col.setTile(grid, x, floorTy, TileKind.SOLID);
          }
          if (isCastleRoyalHall) {
            mergedCastlePairs.add(leftRoom.id);
            mergedCastlePairs.add(rightRoom.id);
          }
        } else {
          // Standard horizontal doorway (4 tiles tall, completely flush with room floors)
          fillTileRect(grid, col, xFrom, floorTy - 4, xTo - xFrom + 1, 4, TileKind.EMPTY);
          for (let x = xFrom; x <= xTo; x++) {
            col.setTile(grid, x, floorTy, TileKind.SOLID);
          }

          // Destructible wooden door in ~65% of doorways
          if (rng.chance(0.65)) {
            const doorX = (xFrom + xTo + 1) * 0.5 * TILE_SIZE;
            state.doors.push({
              uid: state.nextUid++,
              pos: { x: doorX, y: floorTy * TILE_SIZE - 22 },
              width: 12,
              height: 44,
              kind: 'wood',
              opened: false,
              broken: false,
            });
          }
        }
      } else {
        // Vertical chain/ladder shaft (3 tiles wide with continuous climbable core + one-way steps)
        const topRoom = a.gy < b.gy ? roomA : roomB;
        const bottomRoom = a.gy < b.gy ? roomB : roomA;
        // Align shaft cleanly with room midpoint (matching room-graph navigation!)
        const shaftTx = topRoom.tx + Math.floor(topRoom.tw * 0.5);
        const topFloorTy = topRoom.ty + topRoom.th - 1;
        const bottomFloorTy = bottomRoom.ty + bottomRoom.th - 1;

        for (let ty = topFloorTy - 2; ty < bottomFloorTy; ty++) {
          col.setTile(grid, shaftTx - 1, ty, TileKind.EMPTY);
          col.setTile(grid, shaftTx, ty, climbKind);
          col.setTile(grid, shaftTx + 1, ty, TileKind.EMPTY);
        }
        // Cap top entry with flanking one-way ledges for crisp exit onto upper floor
        col.setTile(grid, shaftTx - 1, topFloorTy, TileKind.ONE_WAY);
        col.setTile(grid, shaftTx + 1, topFloorTy, TileKind.ONE_WAY);
        // Mid-shaft resting platform
        const midTy = Math.floor((topFloorTy + bottomFloorTy) * 0.5);
        col.setTile(grid, shaftTx - 2, midTy, TileKind.ONE_WAY);
        col.setTile(grid, shaftTx + 2, midTy, TileKind.ONE_WAY);
        // Ensure bottom landing under shaft is solid (never spikes/acid!)
        col.setTile(grid, shaftTx - 1, bottomFloorTy, TileKind.SOLID);
        col.setTile(grid, shaftTx, bottomFloorTy, TileKind.SOLID);
        col.setTile(grid, shaftTx + 1, bottomFloorTy, TileKind.SOLID);
      }
    }
  }

  state.tileGrid = grid;
  state.rooms = rooms;

  // 5. Place Player Spawn in Entrance Room (guarantee solid ground pad directly underfoot!)
  const entrance = rooms[0]!;
  const entranceFloorTy = entrance.ty + entrance.th - 1;
  const entranceFloorY = entranceFloorTy * TILE_SIZE;
  const spawnTx = entrance.tx + 3;
  for (let dx = -1; dx <= 1; dx++) {
    col.setTile(grid, spawnTx + dx, entranceFloorTy, TileKind.SOLID);
    col.setTile(grid, spawnTx + dx, entranceFloorTy - 1, TileKind.EMPTY);
    col.setTile(grid, spawnTx + dx, entranceFloorTy - 2, TileKind.EMPTY);
  }
  const spawnX = spawnTx * TILE_SIZE;
  const spawnY = entranceFloorY - PLAYER_HEIGHT * 0.5;
  state.player.pos = { x: spawnX, y: spawnY };
  state.player.prevPos = { x: spawnX, y: spawnY };
  state.player.vel = { x: 0, y: 0 };
  state.player.facing = 1;
  state.player.grounded = true;
  state.player.onOneWay = false;
  state.player.diveSlamState = 'none';
  state.player.fallStartY = spawnY;
  state.player.fallStunTicks = 0;
  state.player.airJumpsLeft = state.player.maxAirJumps;

  // Starting Chamber in Prisoner's Quarters: 3 free Starter Pedestals OR 3 Recycling Tubes!
  if (biome.id === 'PrisonStart') {
    if (state.metaSnapshot.randomStarterUnlocked) {
      const themes: readonly { stat: ScrollStat; title: string; color: [number, number, number] }[] = [
        { stat: 'brutality', title: 'Brutality Recycling Tube', color: [1.0, 0.32, 0.32] },
        { stat: 'tactics', title: 'Tactics Recycling Tube', color: [0.74, 0.44, 1.0] },
        { stat: 'survival', title: 'Survival Recycling Tube', color: [0.34, 0.96, 0.54] },
      ];
      const tubeOffsets = [5, 7, 13];
      for (let t = 0; t < themes.length; t++) {
        const theme = themes[t]!;
        const tx = findSafeFloorTx(grid, col, entrance, entrance.tx + tubeOffsets[t]!);
        const tubePos = { x: tx * TILE_SIZE, y: entranceFloorY };
        state.shrines.push({
          uid: state.nextUid++,
          pos: tubePos,
          kind: 'recyclingTube',
          used: false,
          label: theme.title,
          colorFilter: theme.stat,
          tubeLoadout: rollRecyclingTubeLoadout(state, rng, theme.stat),
        });
        addWorldLight(state, tubePos.x, tubePos.y - 22, 85, theme.color, 0.92, 'scroll', 3.5, 0.1);
        reachTargets.push({ label: `tube:${theme.stat}`, pos: { x: tubePos.x, y: entranceFloorY - 12 } });
      }
    } else {
      const starterIds = ['StartSword', 'StartShield', 'CloseCombatBow'] as const;
      const pedOffsets = [5, 7, 13];
      for (let s = 0; s < starterIds.length; s++) {
        const defId = starterIds[s]!;
        const tx = findSafeFloorTx(grid, col, entrance, entrance.tx + pedOffsets[s]!);
        const px = tx * TILE_SIZE;
        const py = entranceFloorY - 12;
        const gear = createPedestalStarterWeapon(state, defId);
        state.pickups.push({
          uid: state.nextUid++,
          kind: 'gear',
          pos: { x: px, y: py },
          prevPos: { x: px, y: py },
          vel: { x: 0, y: 0 },
          value: 0,
          gear,
          priceGold: 0,
          label: defId,
          magnetTicks: 0,
          collected: false,
          bobPhase: s * 0.9,
        });
      }
    }
  }

  // Entrance Teleporter Rune + Lore Skeleton
  const entranceTpTx = findSafeFloorTx(grid, col, entrance, entrance.tx + (biome.id === 'PrisonStart' ? 15 : 9));
  const entranceTpPos = { x: entranceTpTx * TILE_SIZE, y: entranceFloorY - 12 };
  state.teleporters.push({
    uid: state.nextUid++,
    pos: entranceTpPos,
    roomId: entrance.id,
    label: 'Entrance Gate',
    activated: true,
  });
  addWorldLight(state, entranceTpPos.x, entranceTpPos.y - 8, 95, [0.22, 0.91, 1.0], 0.95, 'portal');

  const loreTx = findSafeFloorTx(grid, col, entrance, entrance.tx + entrance.tw - 3);
  state.shrines.push({
    uid: state.nextUid++,
    pos: { x: loreTx * TILE_SIZE, y: entranceFloorY },
    kind: 'loreSkeleton',
    used: false,
    label: 'Inspect Fallen Prisoner',
  });

  // 6. Populate Special Rooms (Exits, Chests, Shops, Challenge Rift, Teleporters)
  let tpCounter = 1;
  const combatRoomIds: number[] = [];

  for (let i = 1; i < rooms.length; i++) {
    const r = rooms[i]!;
    const floorTy = r.ty + r.th - 1;
    const floorY = floorTy * TILE_SIZE;
    const midTx = findSafeFloorTx(grid, col, r, r.tx + Math.floor(r.tw * 0.5));
    const midX = midTx * TILE_SIZE;

    if (r.type === 'exit' && r.exitBiomeId) {
      const destDef = getBiome(r.exitBiomeId);
      const gateTx = findSafeFloorTx(grid, col, r, r.tx + r.tw - 4);
      col.setTile(grid, gateTx, floorTy - 1, TileKind.EXIT_GATE);
      col.setTile(grid, gateTx, floorTy - 2, TileKind.EXIT_GATE);

      const exitPos = { x: gateTx * TILE_SIZE, y: floorY - 24 };
      state.doors.push({
        uid: state.nextUid++,
        pos: exitPos,
        width: 28,
        height: 48,
        kind: 'biomeExit',
        opened: true,
        broken: false,
        targetBiomeId: r.exitBiomeId,
        label: `Exit → ${destDef.name}`,
      });
      addWorldLight(state, exitPos.x, exitPos.y - 6, 115, [0.24, 0.96, 0.54], 1.1, 'portal');
      reachTargets.push({ label: `exit:${r.exitBiomeId}`, pos: { x: exitPos.x, y: floorY - 12 } });

      // Place a convenience Teleporter Rune in every exit room
      const tpTx = findSafeFloorTx(grid, col, r, r.tx + 4);
      const tpPos = { x: tpTx * TILE_SIZE, y: floorY - 12 };
      state.teleporters.push({
        uid: state.nextUid++,
        pos: tpPos,
        roomId: r.id,
        label: `Path to ${destDef.name}`,
        activated: false,
      });
      addWorldLight(state, tpPos.x, tpPos.y - 8, 90, [0.22, 0.91, 1.0], 0.9, 'portal');
      reachTargets.push({ label: `tp:exit_${r.exitBiomeId}`, pos: tpPos });
    } else if (r.type === 'treasure') {
      const chestPos = { x: midX, y: floorY - 12 };
      state.chests.push({
        uid: state.nextUid++,
        pos: chestPos,
        kind: 'treasure',
        opened: false,
        roomId: r.id,
      });
      addWorldLight(state, chestPos.x, chestPos.y - 10, 100, [1.0, 0.82, 0.3], 1.05, 'scroll');
      reachTargets.push({ label: `chest:treasure_${r.id}`, pos: chestPos });
    } else if (r.type === 'cursedChest') {
      const chestPos = { x: midX, y: floorY - 12 };
      state.chests.push({
        uid: state.nextUid++,
        pos: chestPos,
        kind: 'cursed',
        opened: false,
        roomId: r.id,
      });
      addWorldLight(state, chestPos.x, chestPos.y - 10, 110, [0.88, 0.2, 0.96], 1.15, 'scroll');
      reachTargets.push({ label: `chest:cursed_${r.id}`, pos: chestPos });
    } else if (r.type === 'challengeRift') {
      // Trap Gauntlet: entry rune shrine on left/entry pad, rewards + return teleporter on far end!
      const cell = cells[r.id]!;
      const hasLeftConn = r.neighbors.some((nid) => cells[nid]!.gx < cell.gx);
      const hasRightConn = r.neighbors.some((nid) => cells[nid]!.gx > cell.gx);
      const rewardsOnLeft = hasRightConn && !hasLeftConn;

      const entryTx = rewardsOnLeft ? r.tx + r.tw - 3 : r.tx + 2;
      const rewardBaseTx = rewardsOnLeft ? r.tx + 2 : r.tx + r.tw - 4;

      // Ensure solid safe landing tiles under entry shrine & reward altar
      for (let dx = -1; dx <= 1; dx++) {
        col.setTile(grid, Math.max(r.tx + 1, Math.min(r.tx + r.tw - 2, entryTx + dx)), floorTy, TileKind.SOLID);
        col.setTile(grid, Math.max(r.tx + 1, Math.min(r.tx + r.tw - 2, rewardBaseTx + dx)), floorTy, TileKind.SOLID);
      }

      const shrinePos = { x: entryTx * TILE_SIZE, y: floorY };
      state.shrines.push({
        uid: state.nextUid++,
        pos: shrinePos,
        kind: 'challengeRift',
        used: false,
        label: 'Challenge Rift Gauntlet',
      });
      addWorldLight(state, shrinePos.x, shrinePos.y - 18, 115, [0.96, 0.32, 0.45], 1.15, 'portal');
      reachTargets.push({ label: `shrine:rift_${r.id}`, pos: { x: shrinePos.x, y: floorY - 12 } });

      // Far-end Rift Rewards: Scroll of Power + High-Tier Colorless Gear + 15 Cells + Return Teleporter
      const rewardX = rewardBaseTx * TILE_SIZE;
      const scrollPos = { x: rewardX, y: floorY - 14 };
      state.pickups.push({
        uid: state.nextUid++,
        kind: 'scroll',
        pos: scrollPos,
        prevPos: { ...scrollPos },
        vel: { x: 0, y: 0 },
        value: 1,
        scrollChoices: ['brutality', 'tactics', 'survival'],
        label: 'Rift Scroll of Power',
        magnetTicks: 0,
        collected: false,
        bobPhase: 0,
      });

      const riftGear = rollGearInstance(
        state,
        rng,
        rng.chance(0.6) ? 'weapon' : 'skill',
        Math.max(2, biome.depthTier + 2)
      );
      riftGear.color = 'colorless';
      const gearX = rewardX + (rewardsOnLeft ? 18 : -18);
      state.pickups.push({
        uid: state.nextUid++,
        kind: 'gear',
        pos: { x: gearX, y: floorY - 12 },
        prevPos: { x: gearX, y: floorY - 12 },
        vel: { x: 0, y: 0 },
        value: 0,
        gear: riftGear,
        label: `Rift ${riftGear.defId}`,
        magnetTicks: 0,
        collected: false,
        bobPhase: 1.1,
      });

      state.pickups.push({
        uid: state.nextUid++,
        kind: 'cell',
        pos: { x: rewardX + (rewardsOnLeft ? 30 : -30), y: floorY - 12 },
        prevPos: { x: rewardX + (rewardsOnLeft ? 30 : -30), y: floorY - 12 },
        vel: { x: 0, y: 0 },
        value: 15,
        label: '+15 Rift Cells',
        magnetTicks: 0,
        collected: false,
        bobPhase: 2.2,
      });

      const riftTpTx = rewardsOnLeft ? r.tx + 3 : r.tx + r.tw - 3;
      const riftTpPos = { x: riftTpTx * TILE_SIZE, y: floorY - 12 };
      state.teleporters.push({
        uid: state.nextUid++,
        pos: riftTpPos,
        roomId: r.id,
        label: 'Challenge Rift Exit',
        activated: false,
      });
      addWorldLight(state, rewardX, floorY - 22, 110, [1.0, 0.78, 0.35], 1.1, 'scroll');
      reachTargets.push(
        { label: `rift:scroll_${r.id}`, pos: scrollPos },
        { label: `rift:tp_${r.id}`, pos: riftTpPos }
      );
    } else if (r.type === 'teleporter') {
      const tpPos = { x: midX, y: floorY - 12 };
      state.teleporters.push({
        uid: state.nextUid++,
        pos: tpPos,
        roomId: r.id,
        label: `Sector Shrine ${tpCounter++}`,
        activated: false,
      });
      addWorldLight(state, tpPos.x, tpPos.y - 8, 95, [0.22, 0.91, 1.0], 0.95, 'portal');
      reachTargets.push({ label: `tp:room_${r.id}`, pos: tpPos });
      combatRoomIds.push(r.id);
    } else if (r.type === 'weaponShop' || r.type === 'skillShop' || r.type === 'foodShop') {
      const shopId = state.nextUid++;
      const shopKind: 'weapon' | 'skill' | 'food' =
        r.type === 'weaponShop' ? 'weapon' : r.type === 'skillShop' ? 'skill' : 'food';

      // Merchant NPC shrine standing beside the 3 shop wares
      const merchantTx = findSafeFloorTx(grid, col, r, r.tx + 3);
      const merchantPos = { x: merchantTx * TILE_SIZE, y: floorY };
      state.shrines.push({
        uid: state.nextUid++,
        pos: merchantPos,
        kind: 'merchant',
        used: false,
        label:
          shopKind === 'weapon'
            ? 'Weapon Merchant'
            : shopKind === 'skill'
              ? 'Skill Merchant'
              : 'Food Merchant',
        shopId,
        shopKind,
        rerollCount: 0,
      });
      addWorldLight(state, merchantPos.x, merchantPos.y - 26, 105, [1.0, 0.78, 0.38], 1.05, 'torch');
      reachTargets.push({ label: `merchant:${r.id}`, pos: { x: merchantPos.x, y: floorY - 12 } });

      const basePrice = 420 + biome.depthTier * 200;
      const seenDefIds = new Set<string>();
      for (let slot = 0; slot < 3; slot++) {
        const wareTx = findSafeFloorTx(grid, col, r, r.tx + 7 + slot * 4);
        const sx = wareTx * TILE_SIZE;
        const sy = floorY - 12;

        if (r.type === 'foodShop' && slot === 0) {
          state.pickups.push({
            uid: state.nextUid++,
            kind: 'food',
            pos: { x: sx, y: sy },
            prevPos: { x: sx, y: sy },
            vel: { x: 0, y: 0 },
            value: 15,
            priceGold: 130 + biome.depthTier * 45,
            label: 'Small Food (+15% HP)',
            magnetTicks: 0,
            collected: false,
            bobPhase: slot * 1.1,
            shopId,
          });
        } else if (r.type === 'foodShop' && slot === 1) {
          state.pickups.push({
            uid: state.nextUid++,
            kind: 'food',
            pos: { x: sx, y: sy },
            prevPos: { x: sx, y: sy },
            vel: { x: 0, y: 0 },
            value: 50,
            priceGold: 260 + biome.depthTier * 95,
            label: 'Large Food (+50% HP)',
            magnetTicks: 0,
            collected: false,
            bobPhase: slot * 1.1,
            shopId,
          });
        } else if (r.type === 'foodShop' && slot === 2) {
          state.pickups.push({
            uid: state.nextUid++,
            kind: 'flaskRefill',
            pos: { x: sx, y: sy },
            prevPos: { x: sx, y: sy },
            vel: { x: 0, y: 0 },
            value: 1,
            priceGold: 750 + biome.depthTier * 220,
            label: 'Health Flask Refill',
            magnetTicks: 0,
            collected: false,
            bobPhase: slot * 1.1,
            shopId,
          });
        } else {
          const slotKind = r.type === 'weaponShop' ? 'weapon' : 'skill';
          let gear = rollGearInstance(state, rng, slotKind, Math.max(1, biome.depthTier + 2));
          for (let tries = 0; tries < 4 && seenDefIds.has(gear.defId); tries++) {
            gear = rollGearInstance(state, rng, slotKind, Math.max(1, biome.depthTier + 2));
          }
          seenDefIds.add(gear.defId);
          state.pickups.push({
            uid: state.nextUid++,
            kind: 'gear',
            pos: { x: sx, y: sy },
            prevPos: { x: sx, y: sy },
            vel: { x: 0, y: 0 },
            value: 0,
            gear,
            priceGold: basePrice + slot * 95,
            label: `${gear.defId}`,
            magnetTicks: 0,
            collected: false,
            bobPhase: slot * 1.1,
            shopId,
          });
        }
      }
      reachTargets.push({ label: `shop:${r.id}`, pos: { x: midX, y: floorY - 12 } });
    } else {
      combatRoomIds.push(r.id);
    }
  }

  // 7. Distribute Power Scrolls & Dual Scrolls across explored/combat rooms
  const scrollRoomPool = combatRoomIds.length > 0 ? [...combatRoomIds] : rooms.slice(1).map((r) => r.id);
  const placeScroll = (kind: 'scroll' | 'dualScroll', idx: number): void => {
    if (scrollRoomPool.length === 0) return;
    const rid = scrollRoomPool[idx % scrollRoomPool.length]!;
    const r = rooms[rid]!;
    const floorTy = r.ty + r.th - 1;
    const preferredTx = r.tx + 4 + ((idx * 5) % Math.max(4, r.tw - 8));
    const safeTx = findSafeFloorTx(grid, col, r, preferredTx);
    const sx = safeTx * TILE_SIZE;
    const sy = floorTy * TILE_SIZE - 14;
    const choices: ScrollStat[] =
      kind === 'scroll' ? ['brutality', 'tactics', 'survival'] : pickDistinctDualStats(rng);

    state.pickups.push({
      uid: state.nextUid++,
      kind,
      pos: { x: sx, y: sy },
      prevPos: { x: sx, y: sy },
      vel: { x: 0, y: 0 },
      value: 1,
      scrollChoices: choices,
      label: kind === 'scroll' ? 'Scroll of Power' : 'Dual Scroll',
      magnetTicks: 0,
      collected: false,
      bobPhase: idx * 0.9,
    });
    addWorldLight(state, sx, sy - 6, 95, [0.76, 0.36, 1.0], 1.0, 'scroll');
    reachTargets.push({ label: `${kind}:${idx}`, pos: { x: sx, y: sy } });
  };

  for (let s = 0; s < biome.scrollCount; s++) {
    placeScroll('scroll', s);
  }
  for (let d = 0; d < biome.dualScrollCount; d++) {
    placeScroll('dualScroll', biome.scrollCount + d);
  }

  // 8. Spawn Biome Enemies (with 1–2 Elites in deeper biomes!)
  if (biome.enemyPool.length > 0) {
    let elitesRemaining = biome.depthTier >= 4 ? 2 : biome.depthTier >= 2 ? 1 : 0;

    for (let i = 0; i < combatRoomIds.length; i++) {
      const r = rooms[combatRoomIds[i]!]!;
      const floorTy = r.ty + r.th - 1;
      const floorY = floorTy * TILE_SIZE;
      const count =
        r.type === 'combatArena' ? rng.rangeInt(3, 4) : rng.rangeInt(2, 3);

      for (let eIdx = 0; eIdx < count; eIdx++) {
        const defId = rng.pick(biome.enemyPool);
        const enemyDef = getEnemy(defId);
        const prefTx = r.tx + 4 + ((eIdx * 4 + rng.rangeInt(0, 2)) % Math.max(4, r.tw - 7));
        const safeTx = enemyDef.flying ? prefTx : findSafeFloorTx(grid, col, r, prefTx);
        const ex = safeTx * TILE_SIZE;
        const ey = enemyDef.flying
          ? floorY - rng.rangeInt(56, Math.min(86, (r.th - 3) * TILE_SIZE))
          : floorY - enemyDef.height * 0.5;

        const makeElite =
          elitesRemaining > 0 &&
          eIdx === 0 &&
          (r.type === 'combatArena' || i === combatRoomIds.length - 1);
        if (makeElite) elitesRemaining -= 1;

        const spawned = spawnEnemy(state, defId, ex, ey, r.id, rng, makeElite);
        spawned.patrolMinX = (r.tx + 2) * TILE_SIZE;
        spawned.patrolMaxX = (r.tx + r.tw - 2) * TILE_SIZE;
      }
    }
  }

  // 9. Verify 100% Tile-Space BFS Reachability & Self-Repair if any target blocked
  let check = verifyWorldReachability(grid, rooms, state.player.pos, reachTargets);
  if (!check.reachable) {
    const visited = computeReachableTileMask(grid, state.player.pos);
    for (let i = 0; i < reachTargets.length; i++) {
      const t = reachTargets[i]!;
      if (check.missing.includes(t.label)) {
        carveEmergencyBridgeToTarget(grid, col, visited, t.pos);
      }
    }
    check = verifyWorldReachability(grid, rooms, state.player.pos, reachTargets);
  }

  // Guarantee homunculus player light exists
  ensureHomunculusLight(state);
}

// =============================================================================
// Public Biome World Generator Dispatcher
// =============================================================================

export function generateBiomeWorld(
  state: SimState,
  biomeId: BiomeId,
  rng: RngAPI,
  col: CollisionAPI
): void {
  const biome = getBiome(biomeId);

  // Reset biome-local world arrays cleanly
  state.enemies = [];
  state.projectiles = [];
  state.turrets = [];
  state.pickups = [];
  state.chests = [];
  state.doors = [];
  state.teleporters = [];
  state.shrines = [];
  state.hazards = [];
  state.particlesSim = [];
  state.lights = [];
  state.pendingScroll = null;

  state.bossArenaState = {
    active: false,
    bossId: null,
    bossUid: null,
    lockedLeftX: 0,
    lockedRightX: 0,
    defeated: false,
    bannerTicks: 0,
    engaged: false,
    playerTookHit: false,
  };

  if (biomeId === 'Passage' || biome.isSafeRoom) {
    generatePassageSafeRoom(state, rng, col);
    return;
  }

  state.activeBiomeId = biome.id;
  if (!state.biomesVisited.includes(biome.id)) {
    state.biomesVisited.push(biome.id);
  }
  state.passageState.active = false;
  state.passageState.activeNpc = 'none';
  state.runStatus = 'playing';

  if (biome.isBossArena) {
    generateBossArena(state, biome, rng, col);
  } else {
    generateRegularBiome(state, biome, rng, col);
  }
}
