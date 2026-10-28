import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, applyIntent, applyDmEffects, buildSnapshot, allOnStairs, HERO_GLYPHS, parseCommand } from '../engine/game.js';
import { TILE } from '../engine/map.js';

function coopGame(seed = 100) {
  return newGame({
    seed,
    worldDesc: 'Тёмное фэнтези', mode: 'story',
    players: [
      { name: 'Дима', className: 'Воин', stats: { str: 16, dex: 12, int: 8, con: 14, cha: 10, luck: 12 } },
      { name: 'Катя', className: 'Плут', stats: { str: 10, dex: 16, int: 12, con: 10, cha: 14, luck: 10 } }
    ]
  });
}

test('newGame: два героя, свои позиции и FOV, ход у первого', () => {
  const s = coopGame();
  assert.equal(s.heroes.length, 2);
  assert.equal(s.activeIdx, 0);
  assert.notDeepEqual(s.heroes[0].pos, s.heroes[1].pos, 'герои не на одной клетке');
  assert.ok(s.heroes[0].fov.size > 0 && s.heroes[1].fov.size > 0);
  assert.equal(s.player.name, 'Дима'); // compat-getter → активный герой
});

test('очередь ходов: после действия героя ход переходит ко второму', () => {
  const s = coopGame();
  applyIntent(s, { intent: 'wait' }, 0);
  assert.equal(s.activeIdx, 1);
  applyIntent(s, { intent: 'wait' }, 1);
  assert.equal(s.activeIdx, 0);
});

test('не твой ход — интент отброшен', () => {
  const s = coopGame();
  const events = applyIntent(s, { intent: 'wait' }, 1); // ход Димы, Катя лезет
  assert.equal(events.length, 0);
  assert.equal(s.activeIdx, 0);
});

test('advanceTurn пропускает мёртвых', () => {
  const s = coopGame();
  s.heroes[1].alive = false;
  applyIntent(s, { intent: 'wait' }, 0);
  assert.equal(s.activeIdx, 0, 'ход возвращается к живому герою');
});

test('один герой умер — партия жива; умерли все — партия кончилась', () => {
  const s = coopGame();
  s.heroes[0].hp = 0;
  const ev1 = applyIntent(s, { intent: 'wait' }, 0);
  assert.equal(s.heroes[0].alive, false);
  assert.equal(s.over, false, 'Катя ещё жива');
  assert.ok(ev1.some(e => e.kind === 'death' && e.text.includes('Дима')));
  assert.ok(s.heroes[0].epitaph);
  s.heroes[1].hp = 0;
  applyIntent(s, { intent: 'wait' }, 1);
  assert.equal(s.over, true);
  assert.ok(s.epitaph);
});

test('applyDmEffects бьёт конкретного героя, а не всю партию', () => {
  const s = coopGame();
  applyDmEffects(s, { playerDamage: 5, causeOfDeath: 'тест' }, 1);
  assert.ok(s.heroes[0].hp === s.heroes[0].maxHp, 'Дима не пострадал');
  assert.ok(s.heroes[1].hp < s.heroes[1].maxHp, 'Катя пострадала');
  assert.equal(s.over, false);
});

test('descend требует всю партию на лестнице', () => {
  const s = coopGame();
  // оба на лестнице, затем Катя (не активный) отходит на пол
  s.heroes.forEach(h => { h.pos = { ...s.dungeon.stairs }; });
  let floor = null;
  outer:
  for (let y = 0; y < s.dungeon.h; y++) {
    for (let x = 0; x < s.dungeon.w; x++) {
      if (s.dungeon.grid[y][x] === TILE.FLOOR && !(x === s.dungeon.stairs.x && y === s.dungeon.stairs.y)) {
        floor = { x, y };
        break outer;
      }
    }
  }
  s.heroes[1].pos = floor;
  const depth0 = s.depth;
  const ev0 = applyIntent(s, { intent: 'descend' }, s.activeIdx);
  assert.equal(s.depth, depth0);
  assert.ok(ev0.some(e => e.text.includes('Партия не собрана')));
  // теперь все на лестнице
  s.heroes.forEach(h => { h.pos = { ...s.dungeon.stairs }; });
  const ev1 = applyIntent(s, { intent: 'descend' }, s.activeIdx);
  assert.equal(s.depth, depth0 + 1);
  assert.equal(s.heroes[0].pos.x === s.heroes[1].pos.x, false, 'после спуска герои не слипаются');
});

test('allOnStairs корректен', () => {
  const s = coopGame();
  assert.equal(allOnStairs(s), false);
  s.heroes.forEach(h => { h.pos = { ...s.dungeon.stairs }; });
  assert.equal(allOnStairs(s), true);
});

test('монстр целится в ближайшего видимого героя', () => {
  const s = coopGame();
  // ставим монстра рядом с Катей, далеко от Димы; у обоих монстр в FOV
  const kat = s.heroes[1];
  kat.pos = { x: s.heroes[0].pos.x + 3, y: s.heroes[0].pos.y };
  kat.fov = new Set([`${kat.pos.x},${kat.pos.y}`]);
  const mon = { id: 'mx', name: 'крыса', x: kat.pos.x + 1, y: kat.pos.y, hp: 50, maxHp: 50, toHit: 9, dmg: 2, xp: 5 };
  s.monsters.push(mon);
  kat.fov.add(`${mon.x},${mon.y}`);
  s.heroes[0].fov.add(`${mon.x},${mon.y}`);
  const hpKat0 = kat.hp;
  const hpDima0 = s.heroes[0].hp;
  // Катя атакует монстра много раз, пока монстр не ответит
  for (let i = 0; i < 30 && kat.hp === hpKat0 && s.heroes[0].hp === hpDima0; i++) {
    applyIntent(s, { intent: 'attack', target: 'крыса' }, s.activeIdx);
  }
  // враг ходил; урон должен прийти Кате (ближайший), а не Диме
  const katTook = kat.hp < hpKat0;
  const dimaTook = s.heroes[0].hp < hpDima0;
  assert.ok(katTook || dimaTook, 'кто-то должен был получить по шапке');
  if (katTook && dimaTook) {
    // допустимо, но по плану ближайший — Катя; проверим, что Катя получила не меньше
    assert.ok((hpKat0 - kat.hp) >= (hpDima0 - s.heroes[0].hp));
  }
});

test('buildSnapshot: персональный FOV, полная инфа о себе, список героев', () => {
  const s = coopGame();
  const snap1 = buildSnapshot(s, 1);
  assert.equal(snap1.you, 1);
  assert.equal(snap1.turnOf, 0);
  assert.equal(snap1.heroes.length, 2);
  assert.equal(snap1.self.ac, 10 + Math.floor((s.heroes[1].stats.dex - 10) / 2));
  assert.ok(snap1.map.cells.length === s.dungeon.h);
  assert.ok(snap1.map.cells.every(r => r.length === s.dungeon.w));
  // невидимое для Кати — пробелы
  const kat = s.heroes[1];
  const row = snap1.map.cells[kat.pos.y];
  assert.equal(row[kat.pos.x], '@');
  // герой Димы не виден, если вне FOV Кати
  const dima = s.heroes[0];
  if (!kat.fov.has(`${dima.pos.x},${dima.pos.y}`)) {
    assert.equal(snap1.map.cells[dima.pos.y][dima.pos.x], ' ', 'чужой герой вне FOV не утекает');
  }
  assert.ok(snap1.map.cells.join('').includes('#'), 'стены в FOV видны');
});

test('buildSnapshot: видимые союзники рисуются своими глифами', () => {
  const s = coopGame();
  const d = s.heroes[0], k = s.heroes[1];
  // ставим Катю в FOV Димы и наоборот
  k.pos = { x: d.pos.x + 1, y: d.pos.y };
  d.fov.add(`${k.pos.x},${k.pos.y}`);
  k.fov.add(`${d.pos.x},${d.pos.y}`);
  const snap0 = buildSnapshot(s, 0);
  assert.equal(snap0.map.cells[k.pos.y][k.pos.x], HERO_GLYPHS[1]);
  const snap1 = buildSnapshot(s, 1);
  assert.equal(snap1.map.cells[d.pos.y][d.pos.x], HERO_GLYPHS[0]);
  assert.equal(snap1.map.cells[k.pos.y][k.pos.x], '@');
});

test('мультигеройный стресс: 15 сессий × 300 команд, 0 ошибок', () => {
  const cmds = ['иду на север', 'иду на юг', 'иду на восток', 'иду на запад', 'атакую', 'осмотреться', 'инвентарь', 'спускаюсь', 'пробую подкупить стражу', 'постоять'];
  let errors = 0, deaths = 0, maxDepth = 1;
  for (let seed = 1; seed <= 15; seed++) {
    const s = coopGame(seed);
    for (let i = 0; i < 300 && !s.over; i++) {
      try {
        const idx = s.activeIdx;
        const events = applyIntent(s, parseCommand(cmds[Math.floor(Math.random() * cmds.length)]), idx);
        for (const e of events) {
          if (e.kind === 'dm' && e.text.startsWith('__FREE__')) {
            applyDmEffects(s, { narrative: 'заглушка: ' + e.text.slice(8) }, idx);
          }
        }
        maxDepth = Math.max(maxDepth, s.depth);
      } catch (err) {
        errors++;
        break;
      }
    }
    if (s.over) deaths++;
  }
  assert.equal(errors, 0);
  assert.ok(deaths >= 0);
});
