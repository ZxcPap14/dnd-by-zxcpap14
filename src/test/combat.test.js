import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng, makeDice } from '../engine/rng.js';
import {
  rollInitiative, attackRoll, damageRoll, monsterAttack, rollDrop, BASIC_DROP_TABLE
} from '../engine/combat.js';
import { createPlayer, makeItem } from '../engine/player.js';

const stats = { str: 14, dex: 12, int: 10, con: 12, cha: 10, luck: 10 };
const sword = makeItem({ name: 'Меч', type: 'weapon', dmg: 3, bonus: 1 });

test('rollInitiative: d20 + ловкость', () => {
  const dice = makeDice(createRng(1));
  for (let i = 0; i < 200; i++) {
    const { raw, total } = rollInitiative(dice, 14);
    assert.ok(raw >= 1 && raw <= 20);
    assert.equal(total, raw + 2); // mod(14)=2
  }
});

test('attackRoll: крит на 20 всегда попадает, 1 всегда мимо', () => {
  // ищем seed с 20 и с 1 в первых бросках — просто гоняем много раз
  let sawCrit = false, sawFumble = false;
  for (let seed = 0; seed < 500; seed++) {
    const dice = makeDice(createRng(seed));
    const r = attackRoll(dice, stats, sword, 30); // AC 30: попадание только критом
    if (r.crit) { sawCrit = true; assert.ok(r.hit); }
    if (r.fumble) { sawFumble = true; assert.ok(!r.hit); }
  }
  assert.ok(sawCrit, 'за 500 сидов должен встретиться крит');
  assert.ok(sawFumble, 'за 500 сидов должен встретиться провал');
});

test('attackRoll: попадание при total >= AC', () => {
  const dice = makeDice(createRng(3));
  for (let i = 0; i < 300; i++) {
    const r = attackRoll(dice, stats, sword, 14);
    if (!r.crit && !r.fumble) {
      assert.equal(r.hit, r.total >= 14);
    }
  }
});

test('damageRoll: урон минимум 1, крит удваивает кости', () => {
  const dice = makeDice(createRng(4));
  for (let i = 0; i < 100; i++) {
    const d = damageRoll(dice, sword, stats.str, false);
    assert.ok(d.total >= 1);
    assert.equal(d.rolls.length, sword.dmg); // 3d4
  }
  const crit = damageRoll(dice, sword, stats.str, true);
  assert.equal(crit.rolls.length, sword.dmg * 2); // 6d4
  assert.ok(crit.crit);
});

test('monsterAttack: границы и урон только при попадании', () => {
  const dice = makeDice(createRng(6));
  const monster = { name: 'крыса', toHit: 2, dmg: 2, xp: 20 };
  for (let i = 0; i < 300; i++) {
    const r = monsterAttack(dice, monster, 14);
    assert.ok(r.raw >= 1 && r.raw <= 20);
    if (r.hit) assert.ok(r.dmg >= 1); else assert.equal(r.dmg, 0);
    if (r.crit) { assert.ok(r.hit); assert.ok(r.dmg >= monster.dmg); }
  }
});

test('rollDrop: ничего не падает при пустой таблице', () => {
  const dice = makeDice(createRng(1));
  assert.equal(rollDrop(dice, [], 1), null);
});

test('rollDrop: шанс 100% отдаёт предмет', () => {
  const dice = makeDice(createRng(2));
  const item = rollDrop(dice, [{ chance: 1.0, item: { name: 'X', type: 'misc' } }], 1);
  assert.equal(item.name, 'X');
});

test('drop-таблица даёт разные предметы на большом числе бросков', () => {
  const dice = makeDice(createRng(8));
  const names = new Set();
  for (let i = 0; i < 500; i++) {
    const it = rollDrop(dice, BASIC_DROP_TABLE, 1);
    if (it) names.add(it.name);
  }
  assert.ok(names.size >= 3, `разнообразие слабое: ${[...names].join(', ')}`);
});
