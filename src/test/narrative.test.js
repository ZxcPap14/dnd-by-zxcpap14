// narrative.test.js — связность истории: канон мира, знакомые NPC,
// закрытие задач своими словами, выдуманные игроком предметы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, applyDmEffects, addQuest, completeQuest, buildSnapshot, rollPowerCheck, STORY_SHAPES, MAX_QUESTS, applyIntent, parseCommand, clipNarrative, floorLabel, loadVillains, rememberVillain } from '../engine/game.js';
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

// --- журнал не разрастается: иначе нить теряется среди двадцати задач ---
test('журнал: больше MAX_QUESTS задач не копится, новые идут по одной', () => {
  const s = mk();
  for (let i = 0; i < 8; i++) {
    applyDmEffects(s, { questAdd: [`Задача номер ${i}`, `Ещё одна ${i}`, `Третья ${i}`] }, 0);
  }
  assert.ok(s.quests.length <= MAX_QUESTS, `в журнале ${s.quests.length}`);
  const before = s.quests.length;
  applyDmEffects(s, { questAdd: ['Ещё задача'] }, 0);
  assert.ok(s.quests.length <= Math.max(before, MAX_QUESTS));
});

// --- выдуманная способность: исход решает кубик, а не желание игрока ---
test('способность: d20 решает исход и попадает в проверки движка', () => {
  const s = mk();
  assert.equal(rollPowerCheck(s, s.heroes[0], 'осматриваю пол'), null);
  assert.equal(s.recentRolls.length, 0);
  const res = rollPowerCheck(s, s.heroes[0], 'использую свою силу и становлюсь невидимым');
  assert.ok(res && res.roll >= 1 && res.roll <= 20);
  assert.ok(['успех', 'с огрехами', 'провал'].includes(res.verdict));
  assert.match(s.recentRolls.at(-1), /d20\[\d+\]/);
});

// --- формы истории разные, иначе каждый забег про монеты ---
test('сюжет: форма выбирается из набора и попадает в контекст', () => {
  const shapes = new Set();
  for (let i = 0; i < 12; i++) {
    const s = mk(100 + i);
    assert.ok(STORY_SHAPES.includes(s.story.shape));
    shapes.add(s.story.shape);
  }
  assert.ok(shapes.size > 1, 'форма должна меняться между забегами');
  const s = mk(777);
  assert.match(buildContext(s, 'иду вперёд', 0)[1].content, /ФОРМА ИСТОРИИ/);
});


test('повествование: рискованное действие бросает d20, безопасное — нет', () => {
  const s = mk(9001);
  const hero = s.heroes[0];
  assert.equal(rollPowerCheck(s, hero, 'осматриваю пол и стены'), null);
  const easy = rollPowerCheck(s, hero, 'тихо крадусь мимо охраны');
  assert.ok(easy && easy.roll >= 1 && easy.roll <= 20);
  assert.equal(easy.difficulty, 'легко');
  const hard = rollPowerCheck(s, hero, 'взрываю всех одним выстрелом');
  assert.equal(hard.difficulty, 'тяжело');
  assert.match(s.recentRolls.at(-1), /d20\[\d+\]/);
});

test('повествование: пропуск хода не попадает в хронику и в память', () => {
  const s = mk(9002);
  const events = applyIntent(s, parseCommand('ждём'), 0);
  assert.ok(events.length > 0);
  assert.ok(!events.some(e => /тишин/i.test(e.text)), 'пропуск хода не пишет «тишину» в хронику');
  assert.ok(!s.memory.some(m => /тишин/i.test(m)), 'тишина не оседает в памяти ДМа');
});

test('повествование: длинный ответ ДМа режется по границе предложения', () => {
  const long = 'Первое предложение про город. '.repeat(30);
  const cut = clipNarrative(long);
  assert.ok(cut.length <= 451, `длина ${cut.length}`);
  assert.match(cut, /\.$|…$/);
  assert.equal(clipNarrative('Коротко и по делу.'), 'Коротко и по делу.');
});

test('знакомые: каст не больше 12 и не выкидывает тех, о ком помнят', () => {
  const s = mk();
  // Вельгу упоминаем в нарративе — она в памяти, значит «живая»
  applyDmEffects(s, { npcAdd: { name: 'Вельга', role: 'сборщица слухов' }, narrative: 'Вельга стоит у входа.' }, 0);
  for (let i = 0; i < 14; i++) applyDmEffects(s, { npcAdd: { name: 'Прохожий' + i } }, 0);
  assert.ok(s.cast.length <= 12, `длина ${s.cast.length}`);
  assert.ok(s.cast.some(c => c.name === 'Вельга'), 'Вельга осталась в касте');
  assert.ok(!s.cast.some(c => c.name === 'Прохожий0'), 'забытый вытеснен');
});

test('зависшая задача снимается сама, упомянутая — нет', () => {
  const s = mk();
  addQuest(s, 'Узнать, кто собирает дань с местных');
  addQuest(s, 'Дойти до дна подземелья');
  for (let i = 0; i < 9; i++) {
    applyIntent(s, parseCommand('постоять'));
    applyDmEffects(s, {});
    if (i === 4) applyDmEffects(s, { narrative: 'Дно подземелья совсем близко.' });
  }
  assert.deepEqual(s.quests, ['Дойти до дна подземелья']);
});

test('названия уровней под сеттинг', () => {
  assert.equal(floorLabel('Киберпанк 2077', 3), 'Сектор 3');
  assert.equal(floorLabel('Классическое тёмное фэнтези', 3), 'Этаж 3');
  assert.equal(newGame({ seed: 3, worldDesc: 'Киберпанк 2077' }).floorName, 'Сектор 1');
});

test('имена прошлых злодеев не повторяются', () => {
  const s = mk();
  rememberVillain('Архивариус Ноль');
  assert.ok(loadVillains().includes('Архивариус Ноль'));
  const ctx = buildContext(s, 'осмотреться', 0).map(m => m.content).join('\n');
  assert.match(ctx, /УЖЕ БЫЛИ ЗЛОДЕИ[^\n]*Архивариус Ноль/);
  const intro = introMessages(s).map(m => m.content).join('\n');
  assert.match(intro, /Злодеи прошлых забегов/);
});
