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

test('client.chat: jsonMode добавляет response_format', async () => {
  let captured;
  const fakeFetch = async (url, opts) => {
    captured = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
  };
  const client = createClient({ baseUrl: 'x', apiKey: 'k', model: 'm', fetch: fakeFetch });
  await client.chat([{ role: 'user', content: 'hi' }], { jsonMode: true });
  assert.deepEqual(captured.response_format, { type: 'json_object' });
  await client.chat([{ role: 'user', content: 'hi' }], {});
  assert.equal(captured.response_format, undefined, 'без jsonMode поля нет');
});

test('client.chat: провайдер без response_format — авто-retry без него', async () => {
  const bodies = [];
  let calls = 0;
  const fakeFetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    calls++;
    if (calls === 1) {
      return { ok: false, status: 400, text: async () => 'Invalid parameter: response_format is not supported' };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'ок' } }] }) };
  };
  const client = createClient({ baseUrl: 'x', apiKey: 'k', model: 'm', fetch: fakeFetch });
  const answer = await client.chat([{ role: 'user', content: 'hi' }], { jsonMode: true });
  assert.equal(answer, 'ок');
  assert.equal(calls, 2, 'повтор после отказа');
  assert.equal(bodies[1].response_format, undefined, 'повтор без response_format');
});

test('client.chat: 400 не про response_format не ретраится', async () => {
  let calls = 0;
  const client = createClient({
    baseUrl: 'x', apiKey: 'k', model: 'm',
    fetch: async () => { calls++; return { ok: false, status: 400, text: async () => 'model not found' }; }
  });
  await assert.rejects(() => client.chat([], { jsonMode: true }), /model not found/);
  assert.equal(calls, 1);
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

test('buildContext: помечает, КТО ходит в коопе', () => {
  const s = newGame({
    seed: 21, worldDesc: 'Подземелье', mode: 'story',
    players: [
      { name: 'Хост', className: 'Рыцарь', stats: { str: 12, dex: 10, int: 10, con: 12, cha: 10, luck: 10 } },
      { name: 'Друг', className: 'Вор', stats: { str: 8, dex: 14, int: 12, con: 10, cha: 12, luck: 12 } }
    ]
  });
  s.activeIdx = 1;
  const msgs = buildContext(s, 'вскрываю замок', 1);
  const text = msgs[1].content;
  assert.match(text, /ТЕКУЩИЙ ХОД: Друг \(Вор\)/, 'маркер активного героя');
  assert.match(text, /Друг \(Вор, HP \d+\/\d+ — ХОДИТ СЕЙЧАС\)/, 'в ПАРТИИ отмечен ходящий');
  assert.match(text, /ДЕЙСТВИЕ \(Друг\): "вскрываю замок"/, 'действие подписано именем');
  assert.match(text, /СТАТЫ Друг:/, 'статы именно ходящего');
  assert.match(text, /ДРУГИЕ ГЕРОИ[^]*Хост/, 'остальные помечены как другие игроки');
  assert.doesNotMatch(text, /СТАТЫ Хост:/, 'статы чужого героя не подмешаны');
});

test('buildContext: без heroIdx берёт активного героя (совместимость соло)', () => {
  const s = newGame({ seed: 22, worldDesc: 'X', className: 'Y', name: 'Джек' });
  const text = buildContext(s, 'смотрю')[1].content;
  assert.match(text, /ТЕКУЩИЙ ХОД: Джек/);
  assert.match(text, /ДЕЙСТВИЕ \(Джек\)/);
});

test('introMessages: вступление учитывает всю партию', () => {
  const s = newGame({
    seed: 23, worldDesc: 'Пираты', mode: 'story',
    players: [
      { name: 'Хост', className: 'Капитан', stats: { str: 12, dex: 10, int: 10, con: 12, cha: 10, luck: 10 } },
      { name: 'Друг', className: 'Юнга', stats: { str: 8, dex: 14, int: 12, con: 10, cha: 12, luck: 12 } }
    ]
  });
  const text = introMessages(s)[1].content;
  assert.match(text, /Хост/, 'хост упомянут');
  assert.match(text, /Друг/, 'второй герой упомянут');
  assert.match(text, /ОТДЕЛЬНЫЙ человек/, 'указание давать каждому личную линию');
  assert.match(text, /личный интерес/, 'задание на личные зацепки');
});

test('introMessages: соло — без кооп-инструкций', () => {
  const s = newGame({ seed: 24, worldDesc: 'X', mode: 'story', className: 'Y', name: 'Один' });
  const text = introMessages(s)[1].content;
  assert.match(text, /Один/);
  assert.doesNotMatch(text, /ОТДЕЛЬНЫЙ человек/);
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
