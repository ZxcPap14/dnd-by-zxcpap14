import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, parseCommand, applyIntent, applyDmEffects, visibleMonsters, engagedEnemies, buildSnapshot, monsterTurns, DIRS } from '../engine/game.js';
import { attackRoll } from '../engine/combat.js';
import { sanitizeAbility, abilityGoldMult, abilityLifesteal, abilityCritRange } from '../engine/player.js';
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

// ---------- подсказки ДМа (кликабельные варианты действий) ----------

test('applyDmEffects: suggestions превращаются в suggest-событие (JSON, максимум 3)', () => {
  const s = freshGame();
  const events = applyDmEffects(s, {
    narrative: 'Дым рассеивается.',
    suggestions: ['Вскрыть порт ключом', 'Спрятаться в вентиляции', 'Пошуметь', 'Четвёртое лишнее']
  });
  const sug = events.find(e => e.kind === 'suggest');
  assert.ok(sug, 'должно быть suggest-событие');
  const list = JSON.parse(sug.text);
  assert.equal(list.length, 3, 'обрезается до трёх');
  assert.equal(list[0], 'Вскрыть порт ключом');
});

test('applyDmEffects: без подсказок — нет suggest-события; мусор отфильтрован', () => {
  const s = freshGame();
  const events = applyDmEffects(s, { narrative: 'Тишина.', suggestions: ['  ', '', 42] });
  assert.ok(!events.some(e => e.kind === 'suggest'));
});

test('память ДМа не засоряется suggest-событиями', () => {
  const s = freshGame();
  const memBefore = s.memory.length;
  applyDmEffects(s, { narrative: 'Сцена.', suggestions: ['Сделать шаг'] });
  assert.equal(s.memory.length, memBefore + 1, 'в памяти только narrative, без подсказки');
  assert.ok(!s.memory.some(l => l.includes('suggest')));
});

// ---------- боевое окно (враги с HP) и побег ----------

test('парсер: побег — не движение', () => {
  assert.equal(parseCommand('убегаю').intent, 'flee');
  assert.equal(parseCommand('отступаю!').intent, 'flee');
  assert.equal(parseCommand('бегу от гоблина').intent, 'flee');
  assert.equal(parseCommand('убегаю на север').intent, 'flee', 'побег с направлением не должен стать обычным движением');
});

test('flee: герой уходит, ход сгорает, без тупика в открытом поле', () => {
  const s = freshGame();
  s.monsters.push({ id: 'mf', name: 'гоблин', x: s.pos.x + 1, y: s.pos.y, hp: 10, maxHp: 10, toHit: 2, dmg: 1, xp: 10 });
  s.fov.add(`${s.pos.x + 1},${s.pos.y}`);
  const before = { ...s.pos };
  const t0 = s.turn;
  const events = applyIntent(s, { intent: 'flee', raw: 'убегаю' });
  assert.notDeepEqual([s.pos.x, s.pos.y], [before.x, before.y], 'позиция изменилась');
  assert.ok(events.some(e => /ретируется/.test(e.text)));
  assert.equal(s.turn, t0 + 1, 'побег тратит ход');
  assert.ok(!events.some(e => e.kind === 'unhandled'));
});

test('боевое окно: пусто до драки, появляется после атаки, гаснет через 2 хода', () => {
  const s = freshGame();
  const mon = { id: 'mc', name: 'скелет', x: s.pos.x + 1, y: s.pos.y, hp: 20, maxHp: 20, toHit: 0, dmg: 1, xp: 10 };
  s.monsters.push(mon);
  s.fov.add(`${s.pos.x + 1},${s.pos.y}`);
  assert.deepEqual(engagedEnemies(s), [], 'до первой атаки окна нет');
  applyIntent(s, { intent: 'attack', raw: 'атакую скелета' });
  let engaged = engagedEnemies(s);
  assert.equal(engaged.length, 1);
  assert.equal(engaged[0].name, 'скелет');
  assert.equal(engaged[0].maxHp, 20);
  s.turn += 2;
  assert.equal(engagedEnemies(s).length, 1, '2 хода тишины — ещё виден');
  s.turn += 1;
  assert.equal(engagedEnemies(s).length, 0, '3 хода тишины — исчез');
});

test('боевое окно: убитый враг пропадает сразу', () => {
  const s = freshGame();
  const mon = { id: 'md', name: 'слизь', x: s.pos.x + 1, y: s.pos.y, hp: 1, maxHp: 1, toHit: 0, dmg: 1, xp: 5 };
  s.monsters.push(mon);
  s.fov.add(`${s.pos.x + 1},${s.pos.y}`);
  applyIntent(s, { intent: 'attack', raw: 'атакую' });
  mon.hp = 0; // добили (руками, чтобы тест не зависел от кубиков)
  assert.equal(engagedEnemies(s).length, 0);
});

test('снапшот несёт боевое окно для коопа', () => {
  const s = freshGame();
  const mon = { id: 'ms', name: 'крыса-мутант', x: s.pos.x + 1, y: s.pos.y, hp: 20, maxHp: 20, toHit: 0, dmg: 1, xp: 5 };
  s.monsters.push(mon);
  s.fov.add(`${s.pos.x + 1},${s.pos.y}`);
  applyIntent(s, { intent: 'attack', raw: 'атакую' });
  const snap = buildSnapshot(s);
  assert.ok(Array.isArray(snap.combat));
  assert.equal(snap.combat.length, 1);
  assert.equal(snap.combat[0].name, 'крыса-мутант');
});

test('applyDmEffects: enemyDamage открывает боевое окно', () => {
  const s = freshGame();
  const mon = { id: 'mx2', name: 'озлобленный гоблин', x: s.pos.x + 2, y: s.pos.y, hp: 8, maxHp: 8, toHit: 0, dmg: 1, xp: 5 };
  s.monsters.push(mon);
  s.fov.add(`${s.pos.x + 2},${s.pos.y}`);
  applyDmEffects(s, { narrative: 'Ты швыряешь камень.', enemyName: 'гоблин', enemyDamage: 2 });
  const engaged = engagedEnemies(s);
  assert.equal(engaged.length, 1);
  assert.equal(engaged[0].hp, 6);
});

// ---------- кастомные классы: способности должны реально работать ----------

function abilityGame(ability, seed = 42) {
  return newGame({
    seed, worldDesc: 'Пепел', mode: 'sandbox',
    backstory: 'Иван должен кузнецу три монеты.',
    players: [{
      name: 'Иван', className: 'Пепельный жнец',
      stats: { str: 14, dex: 12, int: 12, con: 12, cha: 12, luck: 12 },
      ability
    }]
  });
}

test('sanitizeAbility: мусор отбрасывается, числа зажимаются', () => {
  assert.equal(sanitizeAbility(null), null);
  assert.equal(sanitizeAbility({ active: 'телепорт в тронный зал' }), null);
  const a = sanitizeAbility({ name: '  Кара  ', active: 'heal', power: 999, cd: -5, passive: 'crit', passivePower: 99 });
  assert.equal(a.name, 'Кара');
  assert.equal(a.power, 20);
  assert.equal(a.cd, 1, 'отрицательный кулдаун зажимается в 1');
  assert.equal(a.passivePower, 5);
});

test('парсер: способность по имени и по ключевым словам', () => {
  assert.equal(parseCommand('кара пепла', 'Кара пепла').intent, 'ability');
  assert.equal(parseCommand('применяю способность', 'Кара пепла').intent, 'ability');
  assert.equal(parseCommand('кастую', 'Кара пепла').intent, 'ability');
  assert.equal(parseCommand('иду на север', 'Кара пепла').intent, 'move', 'обычное движение не должно съедаться');
});

test('способность heal: лечит, ставит кулдаун, кулдаун не спамится', () => {
  const s = abilityGame({ name: 'Слово заживления', active: 'heal', power: 6, cd: 3 });
  s.monsters = [];
  s.player.hp = 5;
  const ev = applyIntent(s, { intent: 'ability', raw: 'слово заживления' });
  assert.equal(s.player.hp, 11);
  assert.ok(ev.some(e => /применяет «Слово заживления»/.test(e.text)));
  assert.ok(s.player.abilityReady > s.turn, 'кулдаун выставлен');

  const t0 = s.turn;
  const ev2 = applyIntent(s, { intent: 'ability', raw: 'слово заживления' });
  assert.equal(s.turn, t0, 'неудачная попытка не тратит ход');
  assert.ok(ev2.some(e => /восстанавливается/.test(e.text)));
});

test('способность smite: бьёт врага бонусным уроном', () => {
  const s = abilityGame({ name: 'Кара', active: 'smite', power: 7, cd: 3 });
  const mon = { id: 'mt', name: 'скелет', x: s.pos.x + 1, y: s.pos.y, hp: 200, maxHp: 200, toHit: -5, dmg: 1, xp: 5 };
  s.monsters = [mon];
  s.fov.add(`${s.pos.x + 1},${s.pos.y}`);
  const ev = applyIntent(s, { intent: 'ability', raw: 'кара' });
  assert.ok(ev.some(e => /обрушивает «Кара»/.test(e.text)));
  assert.ok(mon.hp < 200, 'враг получил урон');
  assert.equal(engagedEnemies(s).length, 1, 'враг попал в боевое окно');
});

test('способность stun: враг бьёт на power/2 и пропускает ход', () => {
  const s = abilityGame({ name: 'Гроза', active: 'stun', power: 6, cd: 3 });
  const mon = { id: 'mu', name: 'гоблин', x: s.pos.x + 1, y: s.pos.y, hp: 50, maxHp: 50, toHit: 9, dmg: 4, xp: 5 };
  s.monsters = [mon];
  s.fov.add(`${s.pos.x + 1},${s.pos.y}`);
  const hpBefore = s.player.hp;
  const ev = applyIntent(s, { intent: 'ability', raw: 'гроза' });
  assert.equal(mon.hp, 47, 'урон = ceil(6/2)');
  assert.equal(s.player.hp, hpBefore, 'оглушённый враг не бьёт');
  assert.ok(ev.some(e => /оглушён/.test(e.text)));
});

test('способность dash: уводит на 2 клетки и рвёт бой', () => {
  const s = abilityGame({ name: 'Тень', active: 'dash', power: 5, cd: 3 });
  s.monsters = [];
  s.player.combat = { ghost: 0 };
  const WORDS = { '0,-1': 'север', '0,1': 'юг', '1,0': 'восток', '-1,0': 'запад' };
  let word = null;
  for (const [dx, dy] of [[0, -1], [0, 1], [1, 0], [-1, 0]]) {
    const nx = s.pos.x + dx, ny = s.pos.y + dy;
    if (nx >= 0 && ny >= 0 && nx < s.dungeon.w && ny < s.dungeon.h && s.dungeon.grid[ny][nx] !== TILE.WALL) {
      word = WORDS[`${dx},${dy}`];
      break;
    }
  }
  assert.ok(word, 'рядом есть свободная клетка');
  const before = { ...s.pos };
  const ev = applyIntent(s, { intent: 'ability', raw: `тень на ${word}` });
  assert.notDeepEqual([s.pos.x, s.pos.y], [before.x, before.y], 'герой сдвинулся');
  assert.equal(Object.keys(s.player.combat).length, 0, 'рывок разорвал бой');
  assert.ok(ev.some(e => /перемахивает/.test(e.text)));
});

test('пассивка crit: расширяет диапазон крита', () => {
  const hero = { ability: { passive: 'crit', passivePower: 5 } };
  assert.equal(abilityCritRange(hero), 5);
  const fake = { d20: () => 16 };
  const r = attackRoll(fake, { str: 12, dex: 12 }, { type: 'weapon', dmg: 2 }, 30, abilityCritRange(hero));
  assert.equal(r.crit, true, '16 при диапазоне 5 — крит');
  const r2 = attackRoll(fake, { str: 12, dex: 12 }, { type: 'weapon', dmg: 2 }, 30, 1);
  assert.equal(r2.crit, false, 'без пассивки 16 — не крит');
});

test('пассивка lifesteal: лечит от нанесённого урона', () => {
  const s = abilityGame({ name: 'Пиявка', passive: 'lifesteal', passivePower: 5 });
  assert.equal(abilityLifesteal(s.player), 25);
  const mon = { id: 'ml', name: 'крыса', x: s.pos.x + 1, y: s.pos.y, hp: 1, maxHp: 1, toHit: -5, dmg: 1, xp: 5 };
  s.monsters = [mon];
  s.fov.add(`${s.pos.x + 1},${s.pos.y}`);
  s.player.hp = 5;
  applyIntent(s, { intent: 'attack', raw: 'атакую' });
  assert.ok(s.player.hp > 5, 'вампиризм вернул здоровье');
});

test('пассивка regen: капает HP за каждый ход', () => {
  const s = abilityGame({ name: 'Живучесть', passive: 'regen', passivePower: 2 });
  s.monsters = [];
  s.player.hp = 5;
  applyIntent(s, { intent: 'wait', raw: 'жду' });
  assert.equal(s.player.hp, 7);
});

test('пассивка gold: множитель золота', () => {
  assert.equal(abilityGoldMult({ ability: { passive: 'gold', passivePower: 4 } }), 2);
  assert.equal(abilityGoldMult({ ability: null }), 1);
  const s = abilityGame({ name: 'Жадина', passive: 'gold', passivePower: 4 });
  s.monsters = [];
  s.floorItems.push({ id: 'g1', name: 'монеты', type: 'gold', qty: 10, x: s.pos.x, y: s.pos.y });
  applyIntent(s, { intent: 'pickup', raw: 'подбираю' });
  assert.equal(s.player.gold, 20, '10 золота × 2');
});

test('способность в снапшоте: клиент коопа видит её и кулдаун', () => {
  const s = abilityGame({ name: 'Кара', active: 'smite', power: 7, cd: 3 });
  const snap = buildSnapshot(s);
  assert.equal(snap.self.ability.name, 'Кара');
  assert.equal(snap.self.abilityCd, 0);
});

// ---------- парсер вынесен в отдельный модуль ----------

test('parser.js самостоятелен: ре-экспорт из game.js не расходится с оригиналом', async () => {
  const direct = await import('../engine/parser.js');
  assert.equal(typeof direct.parseCommand, 'function');
  assert.equal(typeof direct.W, 'function');
  assert.equal(typeof direct.escapeRe, 'function');
  // DIRS из обоих путей — один и тот же объект
  assert.equal(direct.DIRS, DIRS);
  assert.equal(direct.parseCommand('иду на север').intent, parseCommand('иду на север').intent);
});
