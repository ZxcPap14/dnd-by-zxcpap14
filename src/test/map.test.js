import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../engine/rng.js';
import {
  generateDungeon, randomFloor, computeFov, floodReachable,
  hasLineOfSight, dist, TILE, MAP_W, MAP_H, FOV_RADIUS
} from '../engine/map.js';

function gen(seed) {
  return generateDungeon(createRng(seed));
}

test('этаж имеет правильные размеры', () => {
  const d = gen(1);
  assert.equal(d.w, MAP_W);
  assert.equal(d.h, MAP_H);
  assert.equal(d.grid.length, MAP_H);
  assert.equal(d.grid[0].length, MAP_W);
});

test('создаются комнаты и лестница', () => {
  const d = gen(2);
  assert.ok(d.rooms.length >= 4, `комнат мало: ${d.rooms.length}`);
  assert.equal(d.grid[d.stairs.y][d.stairs.x], TILE.STAIRS);
});

test('все комнаты достижимы (связность flood-fill)', () => {
  for (const seed of [1, 2, 3, 4, 5, 42, 777]) {
    const d = gen(seed);
    const start = d.rooms[0];
    const reachable = floodReachable(d, start.cx, start.cy);
    for (const room of d.rooms) {
      const key = `${room.cx},${room.cy}`;
      assert.ok(reachable.has(key), `seed ${seed}: комната ${key} недостижима`);
    }
    // и лестница достижима
    assert.ok(reachable.has(`${d.stairs.x},${d.stairs.y}`), `seed ${seed}: лестница недостижима`);
  }
});

test('randomFloor возвращает проходимую клетку', () => {
  const rng = createRng(3);
  const d = gen(3);
  for (let i = 0; i < 50; i++) {
    const p = randomFloor(rng, d);
    assert.notEqual(d.grid[p.y][p.x], TILE.WALL);
  }
});

test('детерминизм: одинаковый seed → одинаковая карта', () => {
  const a = gen(11), b = gen(11);
  assert.equal(JSON.stringify(a.grid), JSON.stringify(b.grid));
});

test('FOV: радиус respected, герой видит сам себя', () => {
  const d = gen(5);
  const room = d.rooms[0];
  const fov = computeFov(d, room.cx, room.cy);
  assert.ok(fov.has(`${room.cx},${room.cy}`));
  for (const key of fov) {
    const [x, y] = key.split(',').map(Number);
    assert.ok(dist(room.cx, room.cy, x, y) <= FOV_RADIUS);
  }
});

test('LOS блокируется стеной', () => {
  const d = { w: 5, h: 5, grid: [
    '.....'.split('').map(c => c),
    '.....'.split(''),
    '##.##'.split(''),
    '.....'.split(''),
    '.....'.split('')
  ]};
  // заменяем на стены в grid: строка 2 — стены
  d.grid[2] = ['#', '#', '.', '#', '#'];
  // (0,0) → (0,4): прямой вертикальный путь проходит через (0,2) — стена
  assert.equal(hasLineOfSight(d, 0, 0, 0, 4), false);
  // (2,0) → (2,4): через (2,2) — пол
  assert.equal(hasLineOfSight(d, 2, 0, 2, 4), true);
});

test('соседние этажи различаются', () => {
  const rng = createRng(99);
  const a = generateDungeon(rng);
  const b = generateDungeon(rng);
  assert.notEqual(JSON.stringify(a.grid), JSON.stringify(b.grid));
});
