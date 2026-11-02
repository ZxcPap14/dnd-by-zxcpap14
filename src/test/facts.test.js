import test from 'node:test';
import assert from 'node:assert/strict';

import { newGame, addQuest, completeQuest, buildSnapshot } from '../engine/game.js';
import { addFact, factsDigest } from '../engine/story.js';
import { buildContext } from '../ai/dm.js';
import { dailySeed } from '../engine/rng.js';

const mk = (seed = 42) => newGame({ seed, players: [{ name: 'Дима', className: 'Воин', stats: { str: 14 } }] });

test('addFact: обрезает, не дублирует, держит 14 фактов', () => {
  const s = {};
  assert.equal(addFact(s, '  первое   дело '), 'первое дело');
  assert.equal(addFact(s, 'ПЕРВОЕ ДЕЛО'), null);
  for (let i = 0; i < 20; i++) addFact(s, 'факт ' + i);
  assert.equal(s.facts.length, 14);
  assert.ok(factsDigest(s).includes('факт 19'));
  assert.ok(!factsDigest(s).includes('факт 5'));
  assert.equal(addFact(s, ''), null);
});

test('закрытая задача остаётся в фактах навсегда', () => {
  const s = mk();
  addQuest(s, 'Спасти кузнеца Гарма');
  assert.equal(completeQuest(s, 'кузнец Гарм спасён'), 'Спасти кузнеца Гарма');
  assert.ok(factsDigest(s).includes('Спасти кузнеца Гарма'));
  // старые события вымываются, факт — нет
  for (let i = 0; i < 40; i++) s.memory.push('ход: ' + i);
  assert.ok(factsDigest(s).includes('Спасти кузнеца Гарма'));
});

test('контекст ДМа содержит ВАЖНОЕ', () => {
  const s = mk();
  addFact(s, 'кузнец Гарм спасён');
  const ctx = buildContext(s, 'осмотреться', 0);
  assert.ok(ctx[1].content.includes('ВАЖНОЕ'));
  assert.ok(ctx[1].content.includes('кузнец Гарм спасён'));
});

test('забег дня: одна дата — один сид, разные дни — разные', () => {
  const a = dailySeed(new Date(2026, 10, 2, 9, 0));
  const b = dailySeed(new Date(2026, 10, 2, 23, 30));
  const c = dailySeed(new Date(2026, 10, 3, 9, 0));
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('одинаковый сид даёт одинаковое подземелье', () => {
  const grid = s => s.dungeon.grid.map(row => row.join('')).join('/');
  const seed = dailySeed(new Date(2026, 10, 2));
  const one = mk(seed), two = mk(seed);
  assert.equal(grid(one), grid(two));
  assert.equal(one.floorName, two.floorName);
  assert.equal(buildSnapshot(one, 0).map.cells.join('/'), buildSnapshot(two, 0).map.cells.join('/'));
});
