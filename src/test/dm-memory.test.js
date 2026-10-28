// dm-memory.test.js — кольцевая память ДМа между ходами.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, applyIntent, parseCommand, rememberEvents, memoryDigest, applyDmEffects } from '../engine/game.js';
import { buildContext } from '../ai/dm.js';

const STATS = { str: 12, dex: 14, int: 10, con: 12, cha: 12, luck: 10 };

function mk() {
  return newGame({ seed: 777, worldDesc: 'Тестовый мир', mode: 'sandbox', players: [{ name: 'Дима', className: 'Плут', stats: STATS }] });
}

test('движок запоминает события ходов', () => {
  const s = mk();
  applyIntent(s, parseCommand('постоять'));
  applyIntent(s, parseCommand('осмотреться'));
  assert.ok(s.memory.length >= 2, 'события в памяти');
  assert.ok(s.memory.some(l => l.startsWith('system:')), 'с префиксом kind');
});

test('эхо __FREE__ не попадает в память, но нарратив ДМа попадает', () => {
  const s = mk();
  const freeEvents = applyIntent(s, { intent: 'free', text: 'где-то тут был выход?' });
  applyDmEffects(s, { narrative: 'ДМ посмеялся над твоей уверенностью.' }, 0);
  assert.ok(freeEvents.some(e => e.text.startsWith('__FREE__')), 'эхо было');
  assert.ok(!s.memory.some(l => l.includes('__FREE__')), 'эхо не в памяти');
  assert.ok(s.memory.some(l => l.includes('посмеялся')), 'нарратив ДМа в памяти');
});

test('память кольцевая: не растёт бесконечно (кап 14)', () => {
  const s = mk();
  for (let i = 0; i < 30; i++) applyIntent(s, parseCommand('постоять'));
  assert.ok(s.memory.length <= 14, `длина ${s.memory.length}`);
  // старое вытеснилось: последнее событие — свежее
  assert.match(s.memory[s.memory.length - 1], /system:/);
});

test('buildContext включает НЕДАВНИЕ СОБЫТИЯ', () => {
  const s = mk();
  applyIntent(s, parseCommand('постоять'));
  applyDmEffects(s, { narrative: 'Ты вспомнил про потерянный ключ.' }, 0);
  const ctx = buildContext(s, 'пробую вспомнить');
  const userMsg = ctx[1].content;
  assert.match(userMsg, /НЕДАВНИЕ СОБЫТИЯ/);
  assert.match(userMsg, /потерянный ключ/);
});

test('buildContext без памяти не содержит пустого блока', () => {
  const s = mk();
  const ctx = buildContext(s, 'что-то делаю');
  assert.ok(!ctx[1].content.includes('НЕДАВНИЕ СОБЫТИЯ: .'), 'нет пустого блока');
});

test('rememberEvents/memoryDigest безопасны на голом состоянии', () => {
  const ghost = {};
  rememberEvents(ghost, [{ kind: 'dm', text: 'тест' }]);
  assert.equal(ghost.memory.length, 1);
  assert.match(memoryDigest(ghost), /тест/);
  assert.equal(memoryDigest({}), '');
});
