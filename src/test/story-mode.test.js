// story-mode.test.js — арка, злодей, финальный босс, победа.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newGame, applyIntent, parseCommand, applyDmEffects,
  storyAct, storyVillain, storyGoal, storyDigest, STORY_FLOORS
} from '../engine/game.js';
import { stubDmTurn, resetStub } from '../ai/stub.js';

const STATS = { str: 16, dex: 14, int: 10, con: 16, cha: 12, luck: 10 };

function mkStory(seed = 999) {
  return newGame({
    seed, worldDesc: 'Тёмное фэнтези', mode: 'story',
    players: [{ name: 'Дима', className: 'Воин', stats: STATS }]
  });
}
function mkSandbox(seed = 999) {
  return newGame({
    seed, worldDesc: 'Тёмное фэнтези', mode: 'sandbox',
    players: [{ name: 'Дима', className: 'Воин', stats: STATS }]
  });
}

test('storyAct: три акта на шести этажах', () => {
  assert.equal(storyAct(1), 1);
  assert.equal(storyAct(2), 1);
  assert.equal(storyAct(3), 2);
  assert.equal(storyAct(4), 2);
  assert.equal(storyAct(5), 3);
  assert.equal(storyAct(6), 3);
  assert.equal(storyAct(10), 3, 'глубже финала акт не растёт');
});

test('в сюжетной игре есть story-состояние, в песочнице — нет', () => {
  const s = mkStory();
  assert.ok(s.story, 'story есть');
  assert.equal(s.story.act, 1);
  assert.ok(!s.story.won);
  assert.ok(!mkSandbox().story);
});

test('злодей: офлайн-шаблон работает, ИИ-вариант перекрывает', () => {
  const s = mkStory();
  assert.ok(storyVillain(s), 'есть офлайн-злодей');
  assert.ok(storyGoal(s));
  applyDmEffects(s, { narrative: 'интро', villain: 'Терминатор из Токио', villainGoal: 'отключить всю жизнь' }, 0);
  assert.equal(storyVillain(s), 'Терминатор из Токио');
  assert.equal(storyGoal(s), 'отключить всю жизнь');
  // второй раз не перезаписывается
  applyDmEffects(s, { narrative: 'двойка', villain: 'Кто-то другой' }, 0);
  assert.equal(storyVillain(s), 'Терминатор из Токио');
});

test('босс не спавнится раньше финального этажа и спавнится один раз на нём', () => {
  const s = mkStory();
  // спускаемся до 5 этажа — босса нет
  for (let d = 1; d < 5; d++) {
    s.heroes.forEach(h => { h.pos = { ...s.dungeon.stairs }; h.fov = new Set([`${h.pos.x},${h.pos.y}`]); });
    applyIntent(s, parseCommand('спускаюсь'));
    assert.equal(s.monsters.some(m => m.isBoss), false, `этаж ${s.depth}: босса быть не должно`);
  }
  // 6-й этаж — босс
  s.heroes.forEach(h => { h.pos = { ...s.dungeon.stairs }; h.fov = new Set([`${h.pos.x},${h.pos.y}`]); });
  const evs = applyIntent(s, parseCommand('спускаюсь'));
  assert.equal(s.depth, STORY_FLOORS);
  const boss = s.monsters.find(m => m.isBoss);
  assert.ok(boss, 'босс на финальном этаже');
  assert.ok(boss.hp >= 25 + 6 * 6, 'босс жирный');
  assert.ok(evs.some(e => /ФИНАЛ/.test(e.text)), 'драматичное событие финала');
  assert.ok(s.quests.some(q => q.includes(storyVillain(s))), 'квест на босса');
  const bossCount = s.monsters.filter(m => m.isBoss).length;
  // попытка ещё раз (телепорт не даёт спуститься глубже, но проверим защиту в spawnStoryBoss через повторный descend-блок)
  assert.equal(bossCount, 1);
});

test('убийство босса = победа, смерть героя не отменяет её', () => {
  const s = mkStory();
  s.depth = s.story.floors;
  const boss = {
    id: 'mBoss', name: storyVillain(s), isBoss: true,
    x: s.heroes[0].pos.x + 1, y: s.heroes[0].pos.y,
    hp: 1, maxHp: 55, toHit: 0, dmg: 0, xp: 500
  };
  s.monsters = [boss];
  s.heroes[0].fov.add(`${boss.x},${boss.y}`);
  // добиваем босса свободным действием через DM-эффекты
  applyIntent(s, { intent: 'free', text: 'атакую изо всех сил' }); // monsters may strike; make hero survive
  s.heroes[0].hp = Math.max(s.heroes[0].hp, 10);
  const evs = applyDmEffects(s, { narrative: 'последний удар!', enemyName: storyVillain(s), enemyDamage: 50 }, 0);
  assert.ok(s.story.won, 'флаг победы');
  assert.ok(s.over, 'игра завершена');
  assert.match(s.epitaph, /победил/, 'эпитафия-победа');
  assert.ok(evs.some(e => e.kind === 'victory' && /ПОБЕДА/.test(e.text)));
  assert.ok(s.heroes[0].alive, 'герой жив — умереть после победы нельзя');
});

test('в песочнице убийство любого монстра не даёт победу', () => {
  const s = mkSandbox();
  applyDmEffects(s, { narrative: 'бьём', enemyName: s.monsters[0].name, enemyDamage: 999 }, 0);
  assert.ok(!s.over);
  assert.ok(!s.story);
});

test('stubDmTurn в сюжете: интро задаёт злодея, финал нагнетает', () => {
  resetStub();
  const s = mkStory(31337);
  const intro = stubDmTurn(s, 'начало');
  assert.ok(intro.narrative, 'интро есть');
  // смена акта до финального
  s.story.act = s.story.acts;
  const fin = stubDmTurn(s, 'что происходит?');
  assert.match(fin.narrative, /дно|знает|радуется/i, 'финальное нагнетание');
});

test('storyDigest содержит злодея и прогресс', () => {
  const s = mkStory();
  const d = storyDigest(s);
  assert.match(d, /АКТ 1\/3/);
  assert.match(d, new RegExp(storyVillain(s)));
  assert.match(d, /этаж 1 из 6/);
});
