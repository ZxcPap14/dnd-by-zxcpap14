import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlayer, gainXp, xpForNextLevel, addItem, removeItem, findItem,
  equipItem, playerAc, playerWeapon, makeItem, mod
} from '../engine/player.js';

test('createPlayer: HP зависит от выносливости', () => {
  const weak = createPlayer({ name: 'A', className: 'X', stats: { con: 8 } });
  const tough = createPlayer({ name: 'B', className: 'X', stats: { con: 18 } });
  assert.ok(weak.maxHp < tough.maxHp);
  assert.equal(weak.hp, weak.maxHp);
});

test('gainXp повышает уровень и лечит', () => {
  const p = createPlayer({ name: 'A', className: 'X' });
  p.hp = 1;
  const before = p.maxHp;
  const levels = gainXp(p, xpForNextLevel(1));
  assert.equal(levels, 1);
  assert.equal(p.level, 2);
  assert.ok(p.maxHp > before);
  assert.ok(p.hp > 1);
});

test('gainXp накапливается через несколько уровней', () => {
  const p = createPlayer({ name: 'A', className: 'X' });
  gainXp(p, 1000);
  assert.ok(p.level >= 3, `level: ${p.level}`);
});

test('отрицательный XP не принимается', () => {
  const p = createPlayer({ name: 'A', className: 'X' });
  gainXp(p, -50);
  assert.equal(p.xp, 0);
  assert.equal(p.level, 1);
});

test('инвентарь: добавление, удаление, стак зелий', () => {
  const p = createPlayer({ name: 'A', className: 'X' });
  const potion = makeItem({ name: 'Зелье', type: 'potion', heal: 5 });
  addItem(p, potion);
  addItem(p, { ...potion, id: 'it999' });
  assert.equal(p.inventory.length, 1);
  assert.equal(p.inventory[0].qty, 2);
  const removed = removeItem(p, p.inventory[0].id);
  assert.ok(removed);
  assert.equal(p.inventory[0].qty, 1); // из стака ушла одна единица
  removeItem(p, p.inventory[0].id);
  assert.equal(p.inventory.length, 0);
});

test('findItem ищет по части имени без регистра', () => {
  const p = createPlayer({ name: 'A', className: 'X' });
  addItem(p, makeItem({ name: 'Зелье лечения', type: 'potion', heal: 8 }));
  assert.ok(findItem(p, 'лечен'));
  assert.ok(findItem(p, 'ЗЕЛЬЕ'));
  assert.equal(findItem(p, 'меч'), null);
});

test('equipItem меняет слот и возвращает прежнее в инвентарь', () => {
  const p = createPlayer({ name: 'A', className: 'X' });
  const sword1 = addItem(p, makeItem({ name: 'Меч А', type: 'weapon', dmg: 3 }));
  equipItem(p, sword1);
  assert.equal(p.equipment.weapon.name, 'Меч А');
  const sword2 = addItem(p, makeItem({ name: 'Меч Б', type: 'weapon', dmg: 4 }));
  equipItem(p, sword2);
  assert.equal(p.equipment.weapon.name, 'Меч Б');
  assert.ok(p.inventory.some(i => i.name === 'Меч А'), 'старое оружие должно вернуться в рюкзак');
});

test('equipItem не экипирует зелье', () => {
  const p = createPlayer({ name: 'A', className: 'X' });
  const potion = addItem(p, makeItem({ name: 'Зелье', type: 'potion', heal: 5 }));
  const res = equipItem(p, potion);
  assert.equal(res.equipped, null);
});

test('playerAc учитывает ловкость и броню', () => {
  const p = createPlayer({ name: 'A', className: 'X', stats: { dex: 14 } });
  const base = playerAc(p);
  assert.equal(base, 12); // 10 + mod(14)=2
  const armor = addItem(p, makeItem({ name: 'Броня', type: 'armor', ac: 3 }));
  equipItem(p, armor);
  assert.equal(playerAc(p), 15);
});

test('playerWeapon: кулаки по умолчанию', () => {
  const p = createPlayer({ name: 'A', className: 'X' });
  assert.equal(playerWeapon(p).name, 'кулаки');
});
