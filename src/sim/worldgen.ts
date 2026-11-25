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
import { getBiome, getBoss, getEnemy } from '../data';
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
    // Keep a 1-tile ruined stone parapet along the floor & spaced gothic stone piers
    for (let x = innerTx; x < innerTx + innerTw; x++) {
      if ((x - innerTx) % 9 === 0) {
        for (let y = innerTy; y < floorTy; y++) {
          setBgTile(grid, x, y, TileKind.BG_WALL);
        }
      } else if ((x - innerTx) % 2 === 0 && biomeId !== 'StiltVillage') {
        setBgTile(grid, x, floorTy - 1, TileKind.BG_WALL);
      }
    }
    return;
  }

  // Indoor gothic halls: carve dramatic arched cathedral/prison windows into upper walls
  // so moonlight, distant towers, and giant clockwork gears shine dramatically inside!
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

  const period = biomeId === 'Sewer' ? 9 : 7;
  const winW = biomeId === 'Castle' || biomeId === 'ClockTower' ? 4 : 3;
  const winTop = Math.max(innerTy + 1, floorTy - 6);
  const winBot = floorTy - 1;
  for (let bx = innerTx + 2; bx + winW <= innerTx + innerTw - 2; bx += period) {
    for (let y = winTop; y < winBot; y++) {
      for (let x = bx; x < bx + winW; x++) {
        // Pointed gothic arch top corners remain stone
        if (y === winTop && (x === bx || x === bx + winW - 1)) continue;
        setBgTile(grid, x, y, 0);
      }
    }
  }
}

const CELL_W = 22;
const CELL_H = 11;
const GRID_COLS = 6;
const GRID_ROWS = 4;
const GRID_PAD_X = 2;
const GRID_PAD_Y = 2;

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

  // Side elevated one-way balconies for dodging shockwaves & aerial combat
  fillTileRect(grid, col, 7, 10, 6, 1, TileKind.ONE_WAY);
  fillTileRect(grid, col, 28, 10, 6, 1, TileKind.ONE_WAY);

  // Throne Room special: iconic left & right recessed spike pits with escape ledges!
  if (biome.id === 'Throne') {
    // Left spike pit (tx: 3..5)
    fillTileRect(grid, col, 3, floorTy, 3, 1, TileKind.SPIKES);
    fillTileRect(grid, col, 3, floorTy - 2, 3, 1, TileKind.ONE_WAY);
    // Right spike pit (tx: 38..40)
    fillTileRect(grid, col, 38, floorTy, 3, 1, TileKind.SPIKES);
    fillTileRect(grid, col, 38, floorTy - 2, 3, 1, TileKind.ONE_WAY);
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

  // Entrance & Exit Boss Gates
  state.doors.push({
    uid: state.nextUid++,
    pos: { x: 4 * TILE_SIZE, y: floorSurfaceY - 24 },
    width: 22,
    height: 48,
    kind: 'bossGate',
    opened: false,
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
  state.player.airJumpsLeft = state.player.maxAirJumps;

  // Spawn the biome's Boss on-screen in dramatic standoff framing!
  const bossId = biome.bossId ?? 'Behemoth';
  const bossDef = getBoss(bossId);
  const bossX = 22 * TILE_SIZE;
  const bossY = floorSurfaceY - bossDef.height * 0.5;
  spawnBoss(state, bossId, bossX, bossY);

  // Add boss aura light
  addWorldLight(state, bossX, bossY - 12, 160, primaryLight, 1.25, 'boss', 6.0, 0.2);

  // Keep lockedLeftX/lockedRightX inside spike pit margins on Throne or walls elsewhere
  state.bossArenaState.lockedLeftX = 2 * TILE_SIZE + 8;
  state.bossArenaState.lockedRightX = (width - 2) * TILE_SIZE - 8;

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
  const minRooms = Math.max(10, biome.roomCountRange[0]);
  const maxRooms = Math.min(GRID_COLS * GRID_ROWS - 2, Math.max(minRooms, biome.roomCountRange[1]));
  const targetRooms = rng.rangeInt(minRooms, maxRooms);

  const worldW = GRID_COLS * CELL_W + GRID_PAD_X * 2;
  const worldH = GRID_ROWS * CELL_H + GRID_PAD_Y * 2;
  const grid = createEmptyGrid(worldW, worldH);

  // 1. Build connected branching Metroidvania cell graph starting at (0, 1)
  const cellMap = new Map<string, PlacedCell>();
  const cells: PlacedCell[] = [];
  const keyOf = (gx: number, gy: number) => `${gx},${gy}`;

  const addCell = (gx: number, gy: number, depth: number): PlacedCell => {
    const cell: PlacedCell = { id: cells.length, gx, gy, neighbors: [], depth };
    cells.push(cell);
    cellMap.set(keyOf(gx, gy), cell);
    return cell;
  };

  addCell(0, 1, 0);

  const dirs: readonly [number, number][] = [
    [1, 0],
    [1, 0], // Slight rightward bias for classic Dead Cells momentum
    [0, 1],
    [0, -1],
    [-1, 0],
  ];

  let attempts = 0;
  while (cells.length < targetRooms && attempts < 400) {
    attempts += 1;
    // Prefer expanding from recent or frontier nodes
    const pickIdx = rng.chance(0.65)
      ? Math.max(0, cells.length - 1 - rng.rangeInt(0, Math.min(3, cells.length - 1)))
      : rng.rangeInt(0, cells.length - 1);
    const base = cells[pickIdx]!;
    const [dx, dy] = rng.pick(dirs);
    const nx = base.gx + dx;
    const ny = base.gy + dy;
    if (nx < 0 || ny < 0 || nx >= GRID_COLS || ny >= GRID_ROWS) continue;
    if (cellMap.has(keyOf(nx, ny))) continue;

    const child = addCell(nx, ny, base.depth + 1);
    base.neighbors.push(child.id);
    child.neighbors.push(base.id);
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
        a.neighbors.push(b.id);
        b.neighbors.push(a.id);
        loopsAdded += 1;
        break;
      }
    }
  }

  // 2. Assign RoomTypes cleanly
  const roomTypes: RoomType[] = new Array(cells.length).fill('corridor');
  const exitBiomeMap = new Map<number, BiomeId>();
  roomTypes[0] = 'entrance';

  // Sort non-entrance rooms by descending depth (farthest first for exits)
  const nonStartIds = cells
    .slice(1)
    .sort((a, b) => b.depth - a.depth || b.gx - a.gx)
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

  const pickFreeRoom = (preferMid = false): number | null => {
    const pool = nonStartIds.filter((id) => !usedSpecial.has(id));
    if (pool.length === 0) return null;
    const chosen = preferMid ? pool[Math.floor(pool.length * 0.5)]! : rng.pick(pool);
    usedSpecial.add(chosen);
    return chosen;
  };

  // Treasure Room
  const treasureId = pickFreeRoom(false);
  if (treasureId !== null) roomTypes[treasureId] = 'treasure';

  // Weapon or Skill Merchant Shop
  const shopId = pickFreeRoom(true);
  if (shopId !== null) roomTypes[shopId] = rng.chance(0.55) ? 'weaponShop' : 'skillShop';

  // Cursed Chest Room
  const cursedId = pickFreeRoom(false);
  if (cursedId !== null) roomTypes[cursedId] = 'cursedChest';

  // Challenge Rift Room
  const riftId = pickFreeRoom(false);
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
    if (hasVertical && rng.chance(0.65)) {
      roomTypes[i] = 'verticalShaft';
    } else if (rng.chance(0.55)) {
      roomTypes[i] = 'combatArena';
    } else {
      roomTypes[i] = 'corridor';
    }
  }

  // 3. Create RoomNode structs & carve room interiors
  const rooms: RoomNode[] = cells.map((c) => {
    const tx = GRID_PAD_X + c.gx * CELL_W + 1;
    const ty = GRID_PAD_Y + c.gy * CELL_H + 1;
    const tw = CELL_W - 2; // 20 tiles
    const th = CELL_H - 2; // 9 tiles
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
      cleared: type === 'entrance' || type === 'exit' || type === 'treasure' || type === 'teleporter' || Boolean(shopKind),
      exitBiomeId: exitBiomeMap.get(c.id),
      shopKind,
    };
  });

  // Carve each room interior + one-way platform tiers + optional hazards/secrets
  const primaryLight = hexToRgb01(biome.lightColors[0] ?? '#ff9d42');
  const secondaryLight = hexToRgb01(biome.lightColors[1] ?? '#ffd27d');
  const accentLight = hexToRgb01(biome.lightColors[2] ?? '#5fd6ff');

  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i]!;
    const innerTx = r.tx + 1;
    const innerTy = r.ty + 1;
    const innerTw = r.tw - 2; // 18 tiles
    const innerTh = r.th - 2; // 7 tiles (floor is at r.ty + r.th - 1)
    const floorTy = r.ty + r.th - 1;

    fillTileRect(grid, col, innerTx, innerTy, innerTw, innerTh, TileKind.EMPTY);
    carveRoomBackground(grid, biome.id, innerTx, innerTy, innerTw, innerTh, floorTy);

    // One-way platform tiers (3 tiles above floor -> trivially single-jumpable!)
    if (r.type === 'combatArena' || r.type === 'corridor' || r.type === 'verticalShaft') {
      fillTileRect(grid, col, innerTx + 2, floorTy - 3, 5, 1, TileKind.ONE_WAY);
      fillTileRect(grid, col, innerTx + innerTw - 7, floorTy - 3, 5, 1, TileKind.ONE_WAY);
      if (r.type === 'combatArena' || r.type === 'verticalShaft') {
        fillTileRect(grid, col, innerTx + 6, floorTy - 6, 6, 1, TileKind.ONE_WAY);
      }
    } else if (r.type === 'entrance' || r.type === 'treasure' || r.type === 'cursedChest') {
      fillTileRect(grid, col, innerTx + 3, floorTy - 3, 4, 1, TileKind.ONE_WAY);
      fillTileRect(grid, col, innerTx + innerTw - 7, floorTy - 3, 4, 1, TileKind.ONE_WAY);
    }

    // Optional jumpable hazard pit (2 tiles wide) in combat rooms ONLY (never near doorways/shafts)
    const hasBottomNeighbor = r.neighbors.some((nid) => cells[nid]!.gy > cells[r.id]!.gy);
    if (
      !hasBottomNeighbor &&
      (r.type === 'combatArena' || r.type === 'corridor') &&
      (biome.hasAcid || (biome.depthTier >= 2 && rng.chance(0.45)))
    ) {
      const pitTx = innerTx + 8;
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

    // Occasional breakable secret wall alcove on solid side edge (when no neighbor on that side)
    const hasRightNeighbor = r.neighbors.some((nid) => cells[nid]!.gx > cells[r.id]!.gx);
    if (!hasRightNeighbor && (r.type === 'corridor' || r.type === 'combatArena') && rng.chance(0.3)) {
      col.setTile(grid, r.tx + r.tw - 1, floorTy - 1, TileKind.SECRET_WALL);
      col.setTile(grid, r.tx + r.tw - 1, floorTy - 2, TileKind.SECRET_WALL);
    }

    // Occasional cracked floor secret pocket in treasure/corridor rooms with no bottom neighbor
    if (!hasBottomNeighbor && r.type === 'treasure' && rng.chance(0.7)) {
      col.setTile(grid, innerTx + 3, floorTy, TileKind.CRACKED_FLOOR);
      col.setTile(grid, innerTx + 4, floorTy, TileKind.CRACKED_FLOOR);
    }

    // Atmospheric wall torches + grounded floor braziers!
    const torchY = (floorTy - 3) * TILE_SIZE;
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

  // 4. Carve doorways & vertical chain/ladder shafts between connected rooms
  const carvedEdges = new Set<string>();
  const climbKind: TileKindValue =
    biome.id === 'PrisonCourtyard' || biome.id === 'StiltVillage' ? TileKind.LADDER : TileKind.CHAIN;

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
        // Horizontal doorway (4 tiles tall, completely flush with room floors)
        const leftRoom = a.gx < b.gx ? roomA : roomB;
        const rightRoom = a.gx < b.gx ? roomB : roomA;
        const floorTy = leftRoom.ty + leftRoom.th - 1;
        const xFrom = leftRoom.tx + leftRoom.tw - 1;
        const xTo = rightRoom.tx;

        fillTileRect(grid, col, xFrom, floorTy - 4, xTo - xFrom + 1, 4, TileKind.EMPTY);
        // Guarantee solid floor across the doorway span
        for (let x = xFrom; x <= xTo; x++) {
          col.setTile(grid, x, floorTy, TileKind.SOLID);
        }

        // Destructible wooden door in ~65% of doorways
        if (rng.chance(0.65)) {
          const doorX = ((xFrom + xTo + 1) * 0.5) * TILE_SIZE;
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
      } else {
        // Vertical chain/ladder shaft (3 tiles wide with continuous climbable core + one-way steps)
        const topRoom = a.gy < b.gy ? roomA : roomB;
        const bottomRoom = a.gy < b.gy ? roomB : roomA;
        // Keep vertical shafts well clear of the entrance room's left spawn pad (tx+4)!
        const shaftTx =
          topRoom.id === 0
            ? topRoom.tx + Math.min(topRoom.tw - 3, Math.max(11, Math.floor(topRoom.tw * 0.65)))
            : topRoom.tx + Math.floor(topRoom.tw * 0.5);
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
  const spawnTx = entrance.tx + 4;
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
  state.player.airJumpsLeft = state.player.maxAirJumps;

  // Track mandatory reachable targets for BFS verification
  const reachTargets: { label: string; pos: Vec2 }[] = [];

  // Entrance Teleporter Rune + Lore Skeleton
  const entranceTpPos = { x: (entrance.tx + 9) * TILE_SIZE, y: entranceFloorY - 12 };
  state.teleporters.push({
    uid: state.nextUid++,
    pos: entranceTpPos,
    roomId: entrance.id,
    label: 'Entrance Gate',
    activated: true,
  });
  addWorldLight(state, entranceTpPos.x, entranceTpPos.y - 8, 95, [0.22, 0.91, 1.0], 0.95, 'portal');
  state.shrines.push({
    uid: state.nextUid++,
    pos: { x: (entrance.tx + 14) * TILE_SIZE, y: entranceFloorY },
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
    const midX = (r.tx + Math.floor(r.tw * 0.5)) * TILE_SIZE;

    if (r.type === 'exit' && r.exitBiomeId) {
      const destDef = getBiome(r.exitBiomeId);
      const gateTx = r.tx + r.tw - 4;
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
      const tpPos = { x: (r.tx + 5) * TILE_SIZE, y: floorY - 12 };
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
      const shrinePos = { x: midX, y: floorY };
      state.shrines.push({
        uid: state.nextUid++,
        pos: shrinePos,
        kind: 'challengeRift',
        used: false,
        label: 'Activate Challenge Rift',
      });
      addWorldLight(state, shrinePos.x, shrinePos.y - 18, 115, [0.96, 0.32, 0.45], 1.15, 'portal');
      reachTargets.push({ label: `shrine:rift_${r.id}`, pos: { x: shrinePos.x, y: floorY - 12 } });
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
      const basePrice = 420 + biome.depthTier * 200;
      for (let slot = 0; slot < 3; slot++) {
        const sx = (r.tx + 5 + slot * 5) * TILE_SIZE;
        const sy = floorY - 12;
        if (r.type === 'foodShop' && slot === 0) {
          state.pickups.push({
            uid: state.nextUid++,
            kind: 'food',
            pos: { x: sx, y: sy },
            prevPos: { x: sx, y: sy },
            vel: { x: 0, y: 0 },
            value: 50,
            priceGold: 220 + biome.depthTier * 85,
            label: 'Merchant Feast (+50% HP)',
            magnetTicks: 0,
            collected: false,
            bobPhase: slot * 1.1,
          });
        } else if (r.type === 'foodShop' && slot === 1) {
          state.pickups.push({
            uid: state.nextUid++,
            kind: 'flaskRefill',
            pos: { x: sx, y: sy },
            prevPos: { x: sx, y: sy },
            vel: { x: 0, y: 0 },
            value: 1,
            priceGold: 750 + biome.depthTier * 220,
            label: 'Health Flask Charge',
            magnetTicks: 0,
            collected: false,
            bobPhase: slot * 1.1,
          });
        } else {
          const slotKind =
            r.type === 'weaponShop'
              ? 'weapon'
              : r.type === 'skillShop'
                ? 'skill'
                : 'amulet';
          const gear = rollGearInstance(state, rng, slotKind, Math.max(1, biome.depthTier + 1));
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
    const sx = (r.tx + 4 + ((idx * 5) % Math.max(4, r.tw - 8))) * TILE_SIZE;
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
        const ex = (r.tx + 4 + ((eIdx * 4 + rng.rangeInt(0, 2)) % Math.max(4, r.tw - 7))) * TILE_SIZE;
        const ey = enemyDef.flying
          ? floorY - rng.rangeInt(56, 86)
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
