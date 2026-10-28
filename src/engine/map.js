// map.js — генерация подземелья (комнаты + коридоры), позиционирование, туман войны.
// Этажи средние: 40x30 по спецификации.

export const TILE = {
  WALL: '#',
  FLOOR: '.',
  DOOR: '+',
  STAIRS: '>'
};

export const MAP_W = 40;
export const MAP_H = 30;
export const FOV_RADIUS = 7;

/**
 * Генерация этажа: случайные комнаты, соединённые L-коридорами.
 * @param {() => number} rng
 * @param {{w?: number, h?: number, roomTries?: number}} opts
 * @returns {{w:number, h:number, grid:string[][], rooms:Array<{x,y,w,h,cx,cy}>, stairs:{x,y}}}
 */
export function generateDungeon(rng, opts = {}) {
  const w = opts.w ?? MAP_W;
  const h = opts.h ?? MAP_H;
  const roomTries = opts.roomTries ?? 60;

  const grid = Array.from({ length: h }, () => Array.from({ length: w }, () => TILE.WALL));
  const rooms = [];

  for (let i = 0; i < roomTries && rooms.length < 10; i++) {
    const rw = 4 + Math.floor(rng() * 6);  // 4..9
    const rh = 3 + Math.floor(rng() * 4);  // 3..6
    const rx = 1 + Math.floor(rng() * (w - rw - 2));
    const ry = 1 + Math.floor(rng() * (h - rh - 2));
    const room = { x: rx, y: ry, w: rw, h: rh, cx: rx + (rw >> 1), cy: ry + (rh >> 1) };

    // пересечение с уже существующими (с отступом 1)
    const overlaps = rooms.some(r =>
      rx < r.x + r.w + 1 && rx + rw + 1 > r.x &&
      ry < r.y + r.h + 1 && ry + rh + 1 > r.y
    );
    if (overlaps) continue;

    for (let y = ry; y < ry + rh; y++)
      for (let x = rx; x < rx + rw; x++)
        grid[y][x] = TILE.FLOOR;
    rooms.push(room);
  }

  // соединяем каждую комнату с предыдущей L-коридором
  for (let i = 1; i < rooms.length; i++) {
    carveCorridor(grid, rooms[i - 1], rooms[i]);
  }

  // лестница вниз — в последней комнате
  const last = rooms[rooms.length - 1];
  const stairs = { x: last.cx, y: last.cy };
  grid[stairs.y][stairs.x] = TILE.STAIRS;

  return { w, h, grid, rooms, stairs };
}

/** L-образный коридор между центрами комнат. */
export function carveCorridor(grid, a, b) {
  let x = a.cx, y = a.cy;
  const horizFirst = (a.cx + a.cy) % 2 === 0;
  const stepX = () => { while (x !== b.cx) { grid[y][x] = TILE.FLOOR; x += b.cx > x ? 1 : -1; } };
  const stepY = () => { while (y !== b.cy) { grid[y][x] = TILE.FLOOR; y += b.cy > y ? 1 : -1; } };
  if (horizFirst) { stepX(); stepY(); } else { stepY(); stepX(); }
  grid[y][x] = TILE.FLOOR;
}

/** Случайная проходимая клетка (для спавна игрока/мобов/лута). */
export function randomFloor(rng, dungeon) {
  for (let tries = 0; tries < 500; tries++) {
    const room = dungeon.rooms[Math.floor(rng() * dungeon.rooms.length)];
    const x = room.x + Math.floor(rng() * room.w);
    const y = room.y + Math.floor(rng() * room.h);
    if (dungeon.grid[y][x] === TILE.FLOOR) return { x, y };
  }
  const f = dungeon.rooms[0];
  return { x: f.cx, y: f.cy };
}

/** Расстояние Чебышёва (8-связность). */
export function dist(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/** Прямая видимость по Брезенхэму (стены блокируют, но сама стена видна). */
export function hasLineOfSight(dungeon, x0, y0, x1, y1) {
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  while (!(x === x1 && y === y1)) {
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
    if (x === x1 && y === y1) break;
    if (dungeon.grid[y][x] === TILE.WALL) return false;
  }
  return true;
}

/**
 * FOV: все клетки в радиусе с прямой видимостью.
 * @returns {Set<string>} ключи "x,y"
 */
export function computeFov(dungeon, px, py, radius = FOV_RADIUS) {
  const visible = new Set();
  for (let y = Math.max(0, py - radius); y <= Math.min(dungeon.h - 1, py + radius); y++) {
    for (let x = Math.max(0, px - radius); x <= Math.min(dungeon.w - 1, px + radius); x++) {
      if (dist(px, py, x, y) > radius) continue;
      if (hasLineOfSight(dungeon, px, py, x, y)) visible.add(`${x},${y}`);
    }
  }
  visible.add(`${px},${py}`);
  return visible;
}

/** Flood fill от точки — для теста связности уровня. */
export function floodReachable(dungeon, sx, sy) {
  const seen = new Set();
  const stack = [[sx, sy]];
  while (stack.length) {
    const [x, y] = stack.pop();
    const key = `${x},${y}`;
    if (seen.has(key)) continue;
    if (x < 0 || y < 0 || x >= dungeon.w || y >= dungeon.h) continue;
    if (dungeon.grid[y][x] === TILE.WALL) continue;
    seen.add(key);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return seen;
}
