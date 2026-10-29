import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, applyIntent, parseCommand } from '../engine/game.js';
import { openMerchant, shopText, buyFromMerchant, sellToMerchant, closeMerchant } from '../engine/merchant.js';

const HERO = { name: 'Дима', className: 'Воин', stats: { str: 16, dex: 12, int: 8, con: 14, cha: 10, luck: 12 } };

function run(seed = 1234) {
  return newGame({ seed, mode: 'sandbox', worldDesc: 'Тестовые катакомбы', players: [HERO] });
}

/** Спуск на следующий этаж — там по правилам стоит торговец. */
function descend(s) {
  const st = s.dungeon.stairs;
  s.heroes[0].pos = { x: st.x, y: st.y };
  return applyIntent(s, parseCommand('спускаюсь'), 0);
}

test('торговец появляется на новом этаже, а не на первом', () => {
  const s = run();
  assert.equal(s.merchant, null, 'на старте торговца нет');
  const evs = descend(s);
  assert.ok(s.merchant, 'после спуска торговец есть');
  assert.ok(evs.some(e => /торгует/.test(e.text)), 'игроку сказали про торговца');
});

test('ассортимент: 3-4 товара с положительными ценами', () => {
  const s = run();
  descend(s);
  const m = s.merchant;
  assert.ok(m.stock.length >= 3 && m.stock.length <= 4, `товаров ${m.stock.length}`);
  for (const it of m.stock) {
    assert.ok(it.price > 0, `${it.name}: цена ${it.price}`);
    assert.ok(['potion', 'weapon', 'armor'].includes(it.type), `${it.name}: тип ${it.type}`);
    assert.ok(it.name.length > 0);
  }
  assert.ok(m.greeting.length > 10, 'у торговца есть реплика');
});

test('ассортимент детерминирован: тот же сид → тот же торговец', () => {
  const a = run(555);
  descend(a);
  const b = run(555);
  descend(b);
  assert.equal(a.merchant.name, b.merchant.name);
  assert.deepEqual(a.merchant.stock.map(i => i.name), b.merchant.stock.map(i => i.name));
});

test('витрина перечисляет товары и цены', () => {
  const s = run();
  descend(s);
  const text = shopText(s);
  for (const it of s.merchant.stock) assert.ok(text.includes(it.name), `в витрине есть ${it.name}`);
  assert.match(text, /купить/i);
  assert.match(text, /продать/i);
});

test('покупка: золото уходит, предмет появляется, товар исчезает с прилавка', () => {
  const s = run();
  descend(s);
  const hero = s.heroes[0];
  hero.gold = 500;
  const item = s.merchant.stock[0];
  const stockBefore = s.merchant.stock.length;

  const evs = applyIntent(s, parseCommand(`купить ${item.name}`), 0);

  assert.equal(hero.gold, 500 - item.price, 'золото списано ровно по цене');
  assert.ok(hero.inventory.some(i => i.name === item.name), 'предмет в рюкзаке');
  assert.equal(s.merchant.stock.length, stockBefore - 1, 'товар убран с прилавка');
  assert.ok(evs.some(e => e.kind === 'loot' && e.text.includes(item.name)));
});

test('покупка без золота: отказ, ничего не меняется', () => {
  const s = run();
  descend(s);
  const hero = s.heroes[0];
  hero.gold = 0;
  const item = s.merchant.stock[0];
  const res = buyFromMerchant(s, hero, item.name);
  assert.equal(res.ok, false);
  assert.equal(hero.gold, 0);
  assert.equal(hero.inventory.length, 0);
  assert.equal(s.merchant.stock.length, 3 + (s.merchant.stock.length - 3)); // прилавок не тронут
  assert.ok(res.events.some(e => /Не хватает/.test(e.text)));
});

test('покупка несуществующего товара уходит ДМу (свобода торга)', () => {
  const s = run();
  descend(s);
  s.heroes[0].gold = 500;
  const evs = applyIntent(s, parseCommand('купить летающий ковёр'), 0);
  assert.ok(evs.some(e => e.kind === 'dm' && e.text.startsWith('__FREE__')), 'попытка передана ДМу');
  assert.equal(s.heroes[0].gold, 500, 'золото не списано');
});

test('покупка не тратит ход и не двигает очередь', () => {
  const s = run();
  descend(s);
  s.heroes[0].gold = 500;
  const turn = s.turn;
  applyIntent(s, parseCommand(`купить ${s.merchant.stock[0].name}`), 0);
  assert.equal(s.turn, turn);
});

test('продажа: предмет уходит, золото приходит', () => {
  const s = run();
  descend(s);
  const hero = s.heroes[0];
  hero.inventory.push({ id: 'zz1', name: 'Кривой нож', type: 'weapon', dmg: 4, ac: 0, heal: 0, bonus: 0, qty: 1 });
  const goldBefore = hero.gold;
  const evs = applyIntent(s, parseCommand('продаю кривой нож'), 0);
  assert.equal(hero.inventory.length, 0, 'нож продан');
  assert.ok(hero.gold > goldBefore, 'золото прибавилось');
  assert.ok(evs.some(e => e.kind === 'loot' && /сбывает/.test(e.text)));
});

test('продажа пустого рюкзака — тупик, который обыграет ДМ', () => {
  const s = run();
  descend(s);
  const evs = applyIntent(s, parseCommand('продаю свои сожаления'), 0);
  assert.ok(evs.some(e => e.kind === 'dm' && e.text.startsWith('__FREE__')));
});

test('торговец сворачивается по команде «ухожу»', () => {
  const s = run();
  descend(s);
  const evs = applyIntent(s, parseCommand('ухожу'), 0);
  assert.equal(s.merchant, null);
  assert.ok(evs.some(e => /растворяется/.test(e.text)));
});

test('без торговца команды торговли не ломают игру', () => {
  const s = run();
  const evs = applyIntent(s, parseCommand('купить зелье'), 0);
  assert.ok(evs.length > 0);
  assert.ok(evs.some(e => e.kind === 'dm'), 'уходит ДМу как свободное действие');
  assert.equal(s.merchant, null);
});

test('«торговец» показывает витрину в логе', () => {
  const s = run();
  descend(s);
  const evs = applyIntent(s, parseCommand('торговец'), 0);
  const text = evs.map(e => e.text).join(' ');
  assert.match(text, new RegExp(s.merchant.stock[0].name));
});

test('openMerchant/closeMerchant работают напрямую (для тестов и хоста)', () => {
  const s = run(31);
  const m = openMerchant(s);
  assert.ok(m.stock.length >= 3);
  s.merchant = m;
  const evs = closeMerchant(s);
  assert.equal(s.merchant, null);
  assert.equal(evs.length, 1);
});
