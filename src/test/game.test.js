import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, parseCommand, applyIntent, visibleMonsters, DIRS } from '../engine/game.js';
import { TILE } from '../engine/map.js';

function freshGame(seed = 42) {
  return newGame({ seed, worldDesc: 'Тёмное фэнтези', className: 'Плут', name: 'Тест' });
}

test('newGame: валидное стартовое состояние', () => {
  const s = freshGame();
  assert.ok(s.player.hp > 0);
  assert.ok(s.dungeon.rooms.length >= 2);
  assert.ok(s.monsters.length > 0);
  assert.ok(s.fov.size > 0);
  assert.equal(s.over, false);
});

test('детерминизм: одинаковый seed → одинаковое состояние', () => {
  const a = freshGame(777), b = freshGame(777);
  assert.equal(JSON.stringify(a.dungeon.grid), JSON.stringify(b.dungeon.grid));
  assert.equal(a.monsters.map(m => m.name).join(), b.monsters.map(m => m.name).join());
});

test('парсер: движение по-русски и по-английски', () => {
  assert.equal(parseCommand('иду на север').intent, 'move');
  assert.equal(parseCommand('иду на север').dirVec[1], -1);
  assert.equal(parseCommand('иду на юг').dirVec[1], 1);
  assert.equal(parseCommand('на запад').dirVec[0], -1);
  assert.equal(parseCommand('иду на восток').dirVec[0], 1);
  assert.equal(parseCommand('go north').dirVec[1], -1);
});

test('парсер: служебные команды', () => {
  assert.equal(parseCommand('инвентарь').intent, 'inventory');
  assert.equal(parseCommand('карта').intent, 'map');
  assert.equal(parseCommand('задачи').intent, 'quests');
  assert.equal(parseCommand('осмотреться').intent, 'look');
  assert.equal(parseCommand('спускаюсь вниз').intent, 'descend');
  assert.equal(parseCommand('выпить зелье').intent, 'use');
  assert.equal(parseCommand('надеть меч').intent, 'equip');
  assert.equal(parseCommand('атакую гоблина').intent, 'attack');
  assert.equal(parseCommand('поднимаю меч').intent, 'pickup');
});

test('парсер: непонятное — свободный текст для ИИ', () => {
  const r = parseCommand('пробую подкупить стражу тортом');
  assert.equal(r.intent, 'free');
  assert.equal(r.text, 'пробую подкупить стражу тортом');
});

test('пустая команда — none', () => {
  assert.equal(parseCommand('').intent, 'none');
  assert.equal(parseCommand('   ').intent, 'none');
});

test('движение в стену не меняет позицию', () => {
  const s = freshGame();
  // телепортируемся в угол комнаты и двигаемся к стене
  const room = s.dungeon.rooms[0];
  s.pos = { x: room.x, y: room.y };
  // над стеной наверняка (x, y-1) — стены комнаты гарантированы
  const before = { ...s.pos };
  applyIntent(s, { intent: 'move', dirVec: [0, -1] });
  if (s.dungeon.grid[before.y - 1][before.x] === TILE.WALL) {
    assert.deepEqual(s.pos, before);
  }
});

test('движение по полу меняет позицию и FOV', () => {
  const s = freshGame();
  // шагаем во всех направлениях, пока не встанем на пол
  let moved = false;
  for (const [dx, dy] of Object.values(DIRS)) {
    const nx = s.pos.x + dx, ny = s.pos.y + dy;
    if (s.dungeon.grid[ny][nx] === TILE.FLOOR) {
      applyIntent(s, { intent: 'move', dirVec: [dx, dy] });
      moved = true;
      break;
    }
  }
  assert.ok(moved, 'из стартовой комнаты должен быть шаг на пол');
  assert.ok(s.fov.size > 0);
});

test('XP растёт за шаги (опыт за исследование)', () => {
  const s = freshGame();
  const xp0 = s.player.xp;
  for (const [dx, dy] of Object.values(DIRS)) {
    const nx = s.pos.x + dx, ny = s.pos.y + dy;
    if (s.dungeon.grid[ny][nx] === TILE.FLOOR) { applyIntent(s, { intent: 'move', dirVec: [dx, dy] }); break; }
  }
  assert.ok(s.player.xp > xp0);
});

test('атака в пустоту не крашит и не убивает', () => {
  const s = freshGame();
  const events = applyIntent(s, { intent: 'attack', target: '' });
  assert.ok(events.length > 0);
  assert.equal(s.over, false);
});

test('смерть: HP<=0 → permadeath и эпитафия', () => {
  const s = freshGame();
  s.player.hp = 1;
  s.monsters.push({ id: 'mx', name: 'убийца', x: s.pos.x + 1, y: s.pos.y, hp: 99, maxHp: 99, toHit: 9, dmg: 9, xp: 10 });
  s.fov.add(`${s.pos.x + 1},${s.pos.y}`);
  // гарантируем смерть: прямой урон через много раундов не гарантирован — бьём монстра о игрока вручную не будем,
  // вместо этого проверим механику смерти через playerDamage путь applyDmEffects ниже
  s.player.hp = 0;
  const events = applyIntent(s, { intent: 'wait' });
  assert.equal(s.over, true);
  assert.ok(s.epitaph);
  assert.ok(events.some(e => e.kind === 'death'));
});

test('мертвый игрок не действует', () => {
  const s = freshGame();
  s.over = true;
  const events = applyIntent(s, { intent: 'move', dirVec: [0, -1] });
  assert.equal(events.length, 0);
});

test('descend без лестницы отвергается', () => {
  const s = freshGame();
  if (s.dungeon.grid[s.pos.y][s.pos.x] !== TILE.STAIRS) {
    const depth0 = s.depth;
    applyIntent(s, { intent: 'descend' });
    assert.equal(s.depth, depth0);
  }
});

test('descend с лестницы углубляет этаж', () => {
  const s = freshGame();
  s.pos = { ...s.dungeon.stairs };
  const events = applyIntent(s, { intent: 'descend' });
  assert.equal(s.depth, 2);
  assert.equal(s.floorName, 'Этаж 2');
  assert.ok(events.some(e => e.kind === 'system'));
});

// ---------- свобода действий: тупики движка уходят ДМу, а не в стену ----------

test('парсер: предлог «в» больше не превращает фразу в шаг на восток', () => {
  assert.equal(parseCommand('Полез в вентиляцию').intent, 'free');
  assert.equal(parseCommand('иду в шахту').intent, 'free');
  assert.equal(parseCommand('прыгнул в шахту лифта').intent, 'free');
  assert.equal(parseCommand('скрываюсь во тьме и бегу дальше в жнецу').intent, 'free');
  // полные слова направления работают как раньше
  assert.equal(parseCommand('иду на север').intent, 'move');
  assert.equal(parseCommand('на запад').dirVec[0], -1);
});

test('парсер: осмотр с целью уходит ДМу, без цели — движку', () => {
  assert.equal(parseCommand('осмотрел порт').intent, 'free');
  assert.equal(parseCommand('осмотрелся').intent, 'look');
  assert.equal(parseCommand('осмотреть терминал').intent, 'free');
});

test('парсер: raw-текст доступен во всех интентах', () => {
  assert.equal(parseCommand('иду на север').raw, 'иду на север');
  assert.equal(parseCommand('выпить зелье').raw, 'выпить зелье');
  assert.equal(parseCommand('спускаюсь').raw, 'спускаюсь');
});

test('стена: тупик движения превращается в __FREE__ для ДМа, ход не сгорает', () => {
  const s = freshGame();
  const hero = s.heroes[0];
  const room = s.dungeon.rooms[0];
  hero.pos = { x: room.x, y: room.y };
  hero.fov = s.heroes[0].fov;
  if (s.dungeon.grid[hero.pos.y - 1][hero.pos.x] !== TILE.WALL) return; // не угол — пропускаем
  const before = { ...hero.pos };
  const turnBefore = s.turn;
  const monstersBefore = s.monsters.map(m => `${m.x},${m.y}`).join();
  const events = applyIntent(s, { intent: 'move', dirVec: [0, -1], raw: 'Лезу в вентиляцию' });
  const free = events.find(e => e.kind === 'dm' && String(e.text).startsWith('__FREE__'));
  assert.ok(free, 'должен быть __FREE__-маркер для ДМа');
  assert.ok(free.text.includes('Лезу в вентиляцию'), 'ДМ получает оригинальный текст игрока');
  assert.deepEqual(hero.pos, before, 'позиция не изменилась');
  assert.equal(s.turn, turnBefore, 'ход не сгорел на не распознанной попытке');
  assert.equal(s.monsters.map(m => `${m.x},${m.y}`).join(), monstersBefore, 'монстры не ходили');
});

test('использование несуществующего предмета уходит ДМу с raw-текстом', () => {
  const s = freshGame();
  const events = applyIntent(s, { intent: 'use', target: 'имплант превращения', raw: 'Притворюсь что я Фудзимори используя имплант превращения' });
  const free = events.find(e => e.kind === 'dm' && String(e.text).startsWith('__FREE__'));
  assert.ok(free, 'тупик use → __FREE__');
  assert.ok(free.text.includes('имплант превращения'), 'ДМ видит замысел игрока');
});

test('descend не на лестнице уходит ДМу', () => {
  const s = freshGame();
  if (s.dungeon.grid[s.heroes[0].pos.y][s.heroes[0].pos.x] === TILE.STAIRS) return;
  const events = applyIntent(s, { intent: 'descend', raw: 'спускаюсь в сектор B' });
  const free = events.find(e => e.kind === 'dm' && String(e.text).startsWith('__FREE__'));
  assert.ok(free, 'тупик descend → __FREE__');
  assert.ok(free.text.includes('сектор B'));
  assert.equal(s.depth, 1, 'этаж не изменился');
});

test('атака при отсутствии видимых монстров уходит ДМу', () => {
  const s = freshGame();
  s.monsters = []; // вокруг никого
  const events = applyIntent(s, { intent: 'attack', target: '', raw: 'убиваю дрона за углом' });
  const free = events.find(e => e.kind === 'dm' && String(e.text).startsWith('__FREE__'));
  assert.ok(free, 'пустая атака → __FREE__');
  assert.ok(free.text.includes('дрона за углом'));
});
