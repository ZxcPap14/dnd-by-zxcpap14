// narrative.test.js — связность истории: канон мира, знакомые NPC,
// закрытие задач своими словами, выдуманные игроком предметы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newGame, applyDmEffects, addQuest, completeQuest, buildSnapshot
} from '../engine/game.js';
import { buildContext, introMessages } from '../ai/dm.js';
import { stubDmTurn, resetStub } from '../ai/stub.js';
import { serializeRun, deserializeRun } from '../engine/save.js';

const STATS = { str: 16, dex: 14, int: 10, con: 16, cha: 12, luck: 10 };

function mk(seed = 7) {
  return newGame({
    seed, worldDesc: 'Тёмное фэнтези', mode: 'story',
    players: [{ name: 'Дима', className: 'Воин', stats: STATS }]
  });
}

test('addQuest: дубль в другой обёртке не заводит вторую задачу', () => {
  const s = mk();
  assert.ok(addQuest(s, 'Найти кузнеца Гарма'));
  assert.equal(addQuest(s, 'найти кузнеца гарма.'), null);
  assert.equal(s.quests.length, 1);
});

test('completeQuest: закрывает задачу по пересказу, а не по точной подстроке', () => {
  const s = mk();
  addQuest(s, 'Найти кузнеца Гарма');
  addQuest(s, 'Дойти до дна подземелья');
  assert.equal(completeQuest(s, 'кузнец Гарм найден и спасён'), 'Найти кузнеца Гарма');
  assert.deepEqual(s.quests, ['Дойти до дна подземелья']);
  assert.equal(completeQuest(s, 'что-то совсем другое'), null);
});

test('applyDmEffects: questAdd массивом, questDone закрывает старую и пишет в лог', () => {
  const s = mk();
  const events = applyDmEffects(s, {
    questAdd: ['Выяснить, кто зовёт Диму', 'Узнать, кто собирает дань', 'Дойти до дна подземелья']
  });
  assert.equal(s.quests.length, 3);
  assert.equal(events.filter(e => e.kind === 'quest').length, 3);

  const done = applyDmEffects(s, { questDone: 'данщик известен' });
  assert.equal(s.quests.length, 2, 'задача про дань закрыта');
  assert.ok(done.some(e => e.kind === 'quest' && e.text.startsWith('✓')));
  assert.ok(!s.quests.some(q => q.includes('дань')));
});

test('worldBrief: задаётся один раз и попадает в контекст ДМа', () => {
  const s = mk();
  applyDmEffects(s, { worldBrief: 'Мир держится на соли. Соляные бароны правят.' });
  applyDmEffects(s, { worldBrief: 'Другой мир, который не должен перезаписать первый.' });
  assert.match(s.worldBrief, /соляные/i);

  const ctx = buildContext(s, 'осмотреться');
  assert.match(ctx.at(-1).content, /КАНОН МИРА \(правда, нельзя переписывать\): Мир держится на соли/);
});

test('npcAdd: знакомые копятся без дублей и видны ДМу', () => {
  const s = mk();
  applyDmEffects(s, { npcAdd: { name: 'Вельга', role: 'сборщица слухов' } });
  applyDmEffects(s, { npcAdd: { name: 'вельга', role: 'дубль' } });
  applyDmEffects(s, { npcAdd: 'Гарм' });
  assert.equal(s.cast.length, 2);
  assert.equal(s.cast[0].role, 'сборщица слухов');

  const ctx = buildContext(s, 'спросить Вельгу');
  assert.match(ctx.at(-1).content, /ЗНАКОМЫЕ \(уже встречались\): Вельга — сборщица слухов; Гарм/);
});

test('выдуманный игроком предмет приходит в инвентарь под своим именем', () => {
  const s = mk();
  applyDmEffects(s, { itemGain: { name: 'Ключ от соляной шахты' } });
  assert.ok(s.heroes[0].inventory.some(i => i.name === 'Ключ от соляной шахты'));
});

test('вступление просит канон мира и разные нити, а заглушка их выдаёт', () => {
  const s = mk();
  const ask = introMessages(s).at(-1).content;
  assert.match(ask, /worldBrief/);
  assert.match(ask, /КАНОН МИРА/);
  assert.match(ask, /2-3 РАЗНЫЕ задачи/);

  resetStub();
  const intro = stubDmTurn(s, 'начало');
  assert.ok(intro.worldBrief.length > 80, 'канон мира не пустой');
  assert.equal(intro.questAdd.length, 3, 'три разные нити');
  assert.equal(new Set(intro.questAdd).size, 3);
  assert.ok(intro.npcAdd?.name);

  applyDmEffects(s, intro);
  assert.equal(s.quests.length, 3);
  assert.equal(s.cast.length, 1);
});

test('канон мира и знакомые переживают сохранение', () => {
  const s = mk();
  applyDmEffects(s, { worldBrief: 'Соль дороже крови.', npcAdd: { name: 'Гарм', role: 'кузнец' } });
  const restored = deserializeRun(JSON.parse(JSON.stringify(serializeRun(s))));
  assert.equal(restored.worldBrief, 'Соль дороже крови.');
  assert.equal(restored.cast[0].name, 'Гарм');
  assert.ok(buildSnapshot(s, 0).worldBrief);
});
