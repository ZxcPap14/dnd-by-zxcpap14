import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng, makeDice, mod, withAdvantage } from '../engine/rng.js';

test('createRng детерминирован при одинаковом seed', () => {
  const a = createRng(42), b = createRng(42);
  const seqA = Array.from({ length: 100 }, () => a());
  const seqB = Array.from({ length: 100 }, () => b());
  assert.deepEqual(seqA, seqB);
});

test('rng выдаёт значения в [0,1)', () => {
  const rng = createRng(12345);
  for (let i = 0; i < 10000; i++) {
    const v = rng();
    assert.ok(v >= 0 && v < 1, `вне диапазона: ${v}`);
  }
});

test('разные seed дают разные последовательности', () => {
  const a = createRng(1), b = createRng(2);
  assert.notEqual(a(), b());
});

test('кубики в границах сторон', () => {
  const dice = makeDice(createRng(7));
  for (let i = 0; i < 500; i++) {
    const d = dice.d(6);
    assert.ok(d >= 1 && d <= 6);
    const d20 = dice.d20();
    assert.ok(d20 >= 1 && d20 <= 20);
  }
});

test('roll(3,6) суммирует три броска', () => {
  const dice = makeDice(createRng(9));
  const { rolls, total } = dice.roll(3, 6);
  assert.equal(rolls.length, 3);
  assert.equal(total, rolls.reduce((s, r) => s + r, 0));
});

test('roll(0,6) — ноль бросков', () => {
  const dice = makeDice(createRng(1));
  const { rolls, total } = dice.roll(0, 6);
  assert.equal(rolls.length, 0);
  assert.equal(total, 0);
});

test('mod: D&D модификаторы', () => {
  assert.equal(mod(10), 0);
  assert.equal(mod(8), -1);
  assert.equal(mod(20), 5);
  assert.equal(mod(9), -1); // округление вниз
});

test('withAdvantage берёт больший из двух d20', () => {
  const dice = makeDice(createRng(5));
  const { raw, rolls } = withAdvantage(dice, true);
  assert.equal(raw, Math.max(...rolls));
  assert.equal(rolls.length, 2);
});
