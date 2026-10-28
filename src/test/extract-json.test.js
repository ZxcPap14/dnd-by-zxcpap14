// extract-json.test.js — спасение JSON, обрезанного reasoning-моделями.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson } from '../ai/client.js';

test('обычный JSON и ```json-обёртка парсятся как раньше', () => {
  assert.equal(extractJson('{"narrative":"ok"}').narrative, 'ok');
  assert.equal(extractJson('Вот результат:\n```json\n{"narrative":"ок"}\n```').narrative, 'ок');
  assert.equal(extractJson('болтовня {"narrative":"в середине"} болтовня').narrative, 'в середине');
});

test('обрезанный по строке JSON спасается (незакрытая строка)', () => {
  const cut = '{"narrative": "Ты с важным видом лезешь в сумку — и нащупываешь там только пусто';
  const r = extractJson(cut);
  assert.ok(r, 'распарсился');
  assert.match(r.narrative, /Ты с важным видом/);
});

test('обрезанный по объекту JSON спасается (незакрытые скобки)', () => {
  const cut = '{"narrative": "Тьма сжалась.", "playerDamage": 4, "questAdd": "Найти выход';
  const r = extractJson(cut);
  assert.ok(r);
  assert.equal(r.playerDamage, 4);
  assert.match(r.questAdd, /Найти выход/);
});

test('обрыв после запятой / на ключе не роняет парсер', () => {
  assert.ok(extractJson('{"narrative": "x", "playerDa'));
  assert.ok(extractJson('{"narrative": "x",'));
});

test('мусор без JSON возвращает null', () => {
  assert.equal(extractJson('никакого json тут нет'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
});
