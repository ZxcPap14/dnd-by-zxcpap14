// Жанры: формы истории не сводятся к фэнтези, ДМ обязан держаться мира игрока.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STORY_SHAPES, newGame, storyAct } from '../engine/game.js';
import { SYSTEM_PROMPT, buildContext } from '../ai/dm.js';
import { resetStub, stubDmTurn } from '../ai/stub.js';

test('форм истории много и они не про один и тот же заговор', () => {
  assert.ok(STORY_SHAPES.length >= 12, 'форм: ' + STORY_SHAPES.length);
  const uniq = new Set(STORY_SHAPES);
  assert.equal(uniq.size, STORY_SHAPES.length);
  for (const s of STORY_SHAPES) assert.ok(s.includes(':'), s);
});

test('промпт требует держаться жанра мира, а не подземелья', () => {
  assert.match(SYSTEM_PROMPT, /ЖАНР ЗАДАЁТ «МИР»/);
  assert.match(SYSTEM_PROMPT, /не обязательно подземелье/i);
});

test('мир попадает в контекст ДМа без подмены на фэнтези', () => {
  const st = newGame({ worldDesc: 'Киберпанк-Токио 2099, неон и корпорации', players: [{ name: 'Курьер', className: 'Хакер' }] });
  const ctx = buildContext(st, 'осмотреться', 0);
  const text = ctx.map(m => m.content).join('\n');
  assert.match(text, /Киберпанк-Токио 2099/);
  assert.doesNotMatch(text, /Классическое тёмное фэнтези/);
  assert.equal(st.story.shape.includes(':'), true);
  assert.equal(storyAct(6), 3);
});

test('заглушка знает место из мира: в нуаре не «подземелье», а «город»', () => {
  resetStub();
  const noir = newGame({ seed: 5, worldDesc: 'Нуар-город 1947: дождь, долги, частный детектив', className: 'Детектив', name: 'Дима' });
  const text = JSON.stringify(stubDmTurn(noir, 'осмотреться'));
  assert.ok(!/подземель/i.test(text), 'про подземелье в нуаре: ' + text.slice(0, 200));
  assert.ok(/город/i.test(text), 'город не упомянут: ' + text.slice(0, 200));
});
