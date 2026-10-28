import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, extractJson } from '../ai/client.js';
import { stubDmTurn, resetStub } from '../ai/stub.js';
import { buildContext, introMessages, classMessages } from '../ai/dm.js';
import { newGame } from '../engine/game.js';

// ---- клиент с мок-fetch ----

test('client.chat: корректный запрос и парсинг ответа', async () => {
  let captured;
  const fakeFetch = async (url, opts) => {
    captured = { url, opts: JSON.parse(opts.body) };
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Привет, герой!' } }] })
    };
  };
  const client = createClient({
    baseUrl: 'https://api.example.com/v1/',
    apiKey: 'sk-test',
    model: 'test-model',
    fetch: fakeFetch
  });
  const answer = await client.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(answer, 'Привет, герой!');
  assert.equal(captured.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(captured.opts.model, 'test-model');
  assert.equal(captured.opts.messages[0].content, 'hi');
});

test('client.chat: ошибка HTTP кидает понятную ошибку', async () => {
  const client = createClient({
    baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm',
    fetch: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' })
  });
  await assert.rejects(() => client.chat([]), /401/);
});

test('client.chat: пустой ответ кидает ошибку', async () => {
  const client = createClient({
    baseUrl: 'x', apiKey: 'k', model: 'm',
    fetch: async () => ({ ok: true, json: async () => ({ choices: [] }) })
  });
  await assert.rejects(() => client.chat([]), /Пустой/);
});

// ---- extractJson ----

test('extractJson: чистый JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test('extractJson: обёртка в ```json', () => {
  assert.deepEqual(extractJson('Вот результат:\n```json\n{"narrative":"хо-хо"}\n```\nприятной игры'), { narrative: 'хо-хо' });
});

test('extractJson: JSON среди болтовни', () => {
  assert.deepEqual(extractJson('конечно! {"xpGain":5} — держи'), { xpGain: 5 });
});

test('extractJson: мусор → null', () => {
  assert.equal(extractJson('никакого json тут нет'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
});

// ---- промпты ----

test('buildContext: содержит мир, героя и действие', () => {
  const s = newGame({ seed: 1, worldDesc: 'Пиратский корабль', className: 'Капитан', name: 'Джек' });
  const msgs = buildContext(s, 'осмотреться');
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[1].content, /Пиратский корабль/);
  assert.match(msgs[1].content, /Джек/);
  assert.match(msgs[1].content, /"осмотреться"/);
});

test('introMessages и classMessages: структура', () => {
  const s = newGame({ seed: 2, worldDesc: 'Славянская нечисть', className: 'Волхв', name: 'Иван' });
  assert.equal(introMessages(s).length, 2);
  assert.match(classMessages('X')[1].content, /JSON/);
});

// ---- офлайн-заглушка ----

test('stubDmTurn: валидные эффекты и разнообразие', () => {
  const s = newGame({ seed: 3, worldDesc: 'Тёмные земли', className: 'Плут', name: 'Q' });
  resetStub();
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    const eff = stubDmTurn(s, 'делаю что-то загадочное');
    assert.ok(eff && typeof eff === 'object');
    assert.ok(typeof eff.narrative === 'string' || eff.enemySpawn || eff.itemGain || eff.questAdd);
    if (eff.narrative) seen.add(eff.narrative);
    // применяем — не должно бросать
    s.rng = (function () { let x = i * 7919; return () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; }; })();
  }
  assert.ok(seen.size > 2, 'заглушка должна быть разнообразной');
});

test('stubDmTurn: ирония на сомнительные идеи', () => {
  const s = newGame({ seed: 4, worldDesc: 'X', className: 'Y', name: 'Z' });
  resetStub();
  const eff = stubDmTurn(s, 'пытаюсь обмануть богов');
  assert.ok(eff.narrative.length > 10);
});
