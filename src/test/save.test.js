import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, applyIntent, parseCommand, buildSnapshot } from '../engine/game.js';
import {
  serializeRun, deserializeRun, saveRun, loadRun, loadRunRaw, clearRun, runSummary, SAVE_KEY
} from '../engine/save.js';

const HERO = { name: 'Дима', className: 'Воин', stats: { str: 16, dex: 12, int: 8, con: 14, cha: 10, luck: 12 } };

function fakeStore() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); }
  };
}

function run(seed = 4242) {
  return newGame({ seed, mode: 'story', worldDesc: 'Тестовые катакомбы', players: [HERO] });
}

test('сейв: состояние переживает JSON-раундтрип без потерь', () => {
  const s = run();
  s.heroes[0].gold = 77;
  s.heroes[0].hp = 5;
  s.heroes[0].inventory.push({ id: 'x1', name: 'Зелье', type: 'potion', dmg: 0, ac: 0, heal: 8, bonus: 0, qty: 2 });
  s.quests.push('Победить Костяного Короля');
  s.turn = 12;
  s.memory.push('system: что-то произошло');

  const json = JSON.parse(JSON.stringify(serializeRun(s, { coop: false })));
  const back = deserializeRun(json);

  assert.ok(back, 'сейв разобрался');
  assert.equal(back.heroes.length, 1);
  assert.equal(back.heroes[0].name, 'Дима');
  assert.equal(back.heroes[0].gold, 77);
  assert.equal(back.heroes[0].hp, 5);
  assert.equal(back.heroes[0].inventory[0].qty, 2);
  assert.deepEqual(back.quests, ['Победить Костяного Короля']);
  assert.equal(back.turn, 12);
  assert.equal(back.memory.at(-1), 'system: что-то произошло');
  assert.equal(back.depth, s.depth);
  assert.equal(back.floorName, s.floorName);
  assert.equal(back.dungeon.grid.length, s.dungeon.grid.length);
  assert.equal(back.dungeon.grid[0].length, s.dungeon.grid[0].length);
  assert.deepEqual(back.dungeon.stairs, s.dungeon.stairs);
  assert.equal(back.monsters.length, s.monsters.length);
});

test('сейв: туман войны (Set) и геттеры состояния восстанавливаются', () => {
  const s = run();
  const back = deserializeRun(serializeRun(s));
  assert.ok(back.heroes[0].fov instanceof Set, 'fov снова Set');
  assert.equal(back.heroes[0].fov.size, s.heroes[0].fov.size);
  // геттеры: state.player/pos/fov указывают на активного героя
  assert.equal(back.player, back.heroes[back.activeIdx]);
  assert.deepEqual(back.pos, back.heroes[back.activeIdx].pos);
  assert.equal(back.fov, back.heroes[back.activeIdx].fov);
});

test('сейв: RNG продолжается с того же места, а не с начала', () => {
  const s = run(777);
  s.rng(); s.rng(); s.rng();
  const data = serializeRun(s);
  const expected = s.rng();          // следующее число после сохранения
  const back = deserializeRun(data);
  assert.equal(back.rng(), expected, 'последовательность продолжается');
});

test('сейв: торговец и сюжет тоже сохраняются', () => {
  const s = run(99);
  const st = s.dungeon.stairs;
  s.heroes[0].pos = { x: st.x, y: st.y };
  applyIntent(s, parseCommand('спускаюсь'), 0);
  assert.ok(s.merchant, 'торговец появился на новом этаже');
  const back = deserializeRun(serializeRun(s));
  assert.equal(back.merchant.name, s.merchant.name);
  assert.equal(back.merchant.stock.length, s.merchant.stock.length);
  assert.equal(back.merchant.stock[0].price, s.merchant.stock[0].price);
  assert.equal(back.story.act, s.story.act);
});

test('сейв: покупка не тратит ход (сейв и торговля дружат)', () => {
  const s = run(99);
  const st = s.dungeon.stairs;
  s.heroes[0].pos = { x: st.x, y: st.y };
  applyIntent(s, parseCommand('спускаюсь'), 0);
  s.heroes[0].gold = 500;
  const turnBefore = s.turn;
  applyIntent(s, parseCommand(`купить ${s.merchant.stock[0].name}`), 0);
  assert.equal(s.turn, turnBefore, 'ход не потрачен');
});

test('хранилище: save → load → clear', () => {
  const store = fakeStore();
  const s = run();
  assert.equal(saveRun(s, { coop: true, room: 'ABCD' }, store), true);
  assert.ok(store.map.has(SAVE_KEY));

  const loaded = loadRun(store);
  assert.ok(loaded, 'забег загрузился');
  assert.equal(loaded.meta.room, 'ABCD');
  assert.equal(loaded.meta.coop, true);
  assert.equal(loaded.state.heroes[0].name, 'Дима');

  clearRun(store);
  assert.equal(loadRun(store), null);
  assert.equal(loadRunRaw(store), null);
});

test('хранилище: битый сейв не роняет игру', () => {
  const store = fakeStore();
  store.setItem(SAVE_KEY, '{это не json');
  assert.equal(loadRun(store), null);
  store.setItem(SAVE_KEY, JSON.stringify({ v: 1, body: {} }));
  assert.equal(loadRun(store), null);
  store.setItem(SAVE_KEY, JSON.stringify({ v: 999, body: { heroes: [{}] } }));
  assert.equal(loadRun(store), null);
  // без хранилища вообще (приватный режим) — просто «нет сейва»
  assert.equal(loadRun(null), null);
  assert.equal(saveRun(run(), {}, null), false);
});

test('сводка для кнопки «продолжить»', () => {
  const s = run();
  const data = serializeRun(s, { coop: true, room: 'ABCD' });
  const line = runSummary(data.meta);
  assert.match(line, /Дима/);
  assert.match(line, /этаж/i);
  assert.match(line, /ход 0/);
  assert.match(line, /ABCD/);
  assert.equal(runSummary({}), '');
});

test('сейв после смерти хранит финал, но игра сама его не грузит', () => {
  const s = run();
  s.over = true;
  s.epitaph = 'съеден слизью';
  const back = deserializeRun(serializeRun(s));
  assert.equal(back.over, true);
  assert.equal(back.epitaph, 'съеден слизью');
});

test('снапшот содержит торговца — клиент коопа видит прилавок', () => {
  const s = run(99);
  const st = s.dungeon.stairs;
  s.heroes[0].pos = { x: st.x, y: st.y };
  applyIntent(s, parseCommand('спускаюсь'), 0);
  const snap = buildSnapshot(s, 0);
  assert.ok(snap.merchant, 'торговец в снапшоте');
  assert.ok(snap.merchant.stock.length >= 3);
  assert.equal(snap.merchant.stock[0].price > 0, true);
});
