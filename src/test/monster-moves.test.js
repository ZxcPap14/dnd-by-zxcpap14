// monster-moves.test.js — монстры преследуют, не проходят сквозь стены, бьют в упор.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, applyIntent, parseCommand, monsterTurns, resolveCombatRound } from '../engine/game.js';
import { TILE } from '../engine/map.js';

const STATS = { str: 12, dex: 14, int: 10, con: 12, cha: 12, luck: 10 };

/** Карта-коридор 5×7: герой (1,1), монстр ставится в заданную точку, всё между — пол. */
function mk(monsterPos) {
  const s = newGame({
    seed: 42, worldDesc: 'Тест', mode: 'sandbox',
    players: [{ name: 'Дима', className: 'Воин', stats: STATS }]
  });
  // принудительно ровный коридор по колонке x=1
  for (let y = 0; y < s.dungeon.h; y++) {
    for (let x = 0; x < s.dungeon.w; x++) {
      s.dungeon.grid[y][x] = (x === 1 || x === 0 || x === 2) ? TILE.FLOOR : TILE.WALL;
    }
  }
  s.dungeon.grid[1][1] = TILE.FLOOR;
  s.heroes[0].pos = { x: 1, y: 1 };
  s.heroes[0].fov = new Set();
  for (let y = 0; y < s.dungeon.h; y++) {
    for (let x = 0; x < s.dungeon.w; x++) {
      if (s.dungeon.grid[y][x] !== TILE.WALL) s.heroes[0].fov.add(`${x},${y}`);
    }
  }
  s.monsters = [{
    id: 'mTest', name: 'крыса-сталкер', x: monsterPos.x, y: monsterPos.y,
    hp: 20, maxHp: 20, toHit: 1, dmg: 1, xp: 30
  }];
  s.floorItems = [];
  return s;
}

test('монстр приближается к видимому герою за ходы', () => {
  const s = mk({ x: 1, y: 5 });
  const d0 = Math.abs(s.monsters[0].y - s.heroes[0].pos.y);
  for (let i = 0; i < 3 && Math.abs(s.monsters[0].y - s.heroes[0].pos.y) > 1; i++) {
    applyIntent(s, parseCommand('постоять'));
  }
  const d1 = Math.abs(s.monsters[0].y - s.heroes[0].pos.y);
  assert.ok(d1 < d0, `сократил дистанцию: ${d0} → ${d1}`);
});

test('монстр бьёт в упор', () => {
  const s = mk({ x: 1, y: 2 }); // соседняя клетка
  const evs = monsterTurns(s);
  const texts = evs.map(e => e.text).join(' ');
  assert.match(texts, /крыса-сталкер/, 'атака или настигание отражены в событиях');
  assert.match(texts, /мимо|нападает|КРИТУЕТ/, 'есть исход атаки');
});

test('монстр не проходит сквозь стены и не встаёт на занятые клетки', () => {
  const s = mk({ x: 1, y: 5 });
  for (let i = 0; i < 8; i++) {
    applyIntent(s, parseCommand('постоять'));
    const m = s.monsters[0];
    assert.equal(s.dungeon.grid[m.y][m.x] === TILE.WALL, false, 'не в стене');
    assert.ok(!(m.x === s.heroes[0].pos.x && m.y === s.heroes[0].pos.y), 'не в герое');
  }
});

test('невидимый монстр бродит и не атакует издалека', () => {
  const s = mk({ x: 1, y: 5 });
  s.heroes[0].fov.delete('1,5'); // монстр «вне зоны видимости»
  const evs = monsterTurns(s);
  const attackTexts = evs.filter(e => /нападает|КРИТУЕТ|мимо/.test(e.text));
  assert.equal(attackTexts.length, 0, 'дальних атак нет');
  assert.ok(s.monsters[0].hp > 0);
});

test('двойного удара за ход нет: подравшийся монстр пропускает monsterTurns', () => {
  const s = mk({ x: 1, y: 2 });
  const hpBefore = s.heroes[0].hp;
  // бой при движении на монстра
  const evs = applyIntent(s, parseCommand('иду на юг'));
  const strikes = evs.filter(e => /крыса-сталкер/.test(e.text) && /нападает|КРИТУЕТ|мимо/.test(e.text)).length;
  assert.ok(strikes <= 1, `не больше одной атаки монстра за ход (было ${strikes}, hp ${hpBefore}→${s.heroes[0].hp})`);
});

test('стресс: 30 ходов с движением — состояние консистентно', () => {
  const s = mk({ x: 1, y: 5 });
  const cmds = ['постоять', 'иду на север', 'иду на юг', 'осмотреться'];
  for (let i = 0; i < 30 && !s.over; i++) {
    applyIntent(s, parseCommand(cmds[i % cmds.length]));
    const m = s.monsters[0];
    if (m.hp > 0) {
      assert.notEqual(s.dungeon.grid[m.y][m.x], TILE.WALL);
    }
  }
});
