import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, applyDmEffects, visibleMonsters } from '../engine/game.js';

function freshGame(seed = 5) {
  return newGame({ seed, worldDesc: 'Киберпанк-Токио', className: 'Хакер', name: 'Нео' });
}

test('applyDmEffects: урон игроку и смерть с причиной', () => {
  const s = freshGame();
  s.player.hp = 5;
  const events = applyDmEffects(s, { playerDamage: 10, causeOfDeath: 'электрический пол' });
  assert.equal(s.over, true);
  assert.equal(s.epitaph, 'электрический пол');
  assert.ok(events.some(e => e.kind === 'death'));
});

test('applyDmEffects: ИИ не может нанести больше 15 урона', () => {
  const s = freshGame();
  s.player.hp = s.player.maxHp;
  applyDmEffects(s, { playerDamage: 999 });
  assert.ok(s.player.hp >= s.player.maxHp - 15);
});

test('applyDmEffects: лечение не превышает maxHp, не действует на мёртвого', () => {
  const s = freshGame();
  s.player.hp = 1;
  applyDmEffects(s, { heal: 999 });
  assert.equal(s.player.hp, s.player.maxHp);
  s.player.hp = 1; s.over = true;
  applyDmEffects(s, { heal: 5 });
  assert.equal(s.player.hp, 1);
});

test('applyDmEffects: спавн монстра с клампами статов', () => {
  const s = freshGame();
  const before = s.monsters.length;
  applyDmEffects(s, { enemySpawn: { name: 'Босс', hp: 9999, toHit: 99, dmg: 99, xp: 9999 } });
  assert.equal(s.monsters.length, before + 1);
  const m = s.monsters[s.monsters.length - 1];
  assert.equal(m.hp, 20);   // кламп сверху
  assert.equal(m.toHit, 5);
  assert.equal(m.dmg, 6);
  assert.equal(m.xp, 200);
});

test('applyDmEffects: урон по врагу убивает и даёт XP', () => {
  const s = freshGame();
  s.monsters.push({ id: 'mx', name: 'гоблин', x: s.pos.x, y: s.pos.y + 1, hp: 5, maxHp: 5, toHit: 1, dmg: 1, xp: 40 });
  s.fov.add(`${s.pos.x},${s.pos.y + 1}`);
  const xp0 = s.player.xp;
  const events = applyDmEffects(s, { enemyDamage: 50, enemyName: 'гоблин' });
  assert.equal(s.monsters.find(m => m.id === 'mx').hp <= 0, true);
  assert.ok(s.player.xp >= xp0 + 40);
  assert.ok(events.some(e => e.kind === 'loot'));
});

test('applyDmEffects: выдача предмета и золота с клампами', () => {
  const s = freshGame();
  applyDmEffects(s, { itemGain: { name: 'Кинжал зари', type: 'weapon', dmg: 999 }, goldGain: 99999 });
  assert.ok(s.player.inventory.some(i => i.name === 'Кинжал зари'));
  const w = s.player.inventory.find(i => i.name === 'Кинжал зари');
  assert.ok(w.dmg <= 8, `dmg кламп: ${w.dmg}`);
  assert.ok(s.player.gold <= 500 + 500); // itemGain.gold путь не задан, goldGain кламп 500
});

test('applyDmEffects: квесты добавляются и закрываются', () => {
  const s = freshGame();
  applyDmEffects(s, { questAdd: 'Найти легендарный сэндвич' });
  assert.ok(s.quests.includes('Найти легендарный сэндвич'));
  applyDmEffects(s, { questDone: 'сэндвич' });
  assert.ok(!s.quests.some(q => q.includes('сэндвич')));
});

test('applyDmEffects: мусорный ввод не взрывает игру', () => {
  const s = freshGame();
  assert.doesNotThrow(() => applyDmEffects(s, null));
  assert.doesNotThrow(() => applyDmEffects(s, undefined));
  assert.doesNotThrow(() => applyDmEffects(s, 'строка вместо объекта'));
  assert.doesNotThrow(() => applyDmEffects(s, { itemGain: 42, enemySpawn: 'x', playerDamage: 'много' }));
});

test('applyDmEffects: narrative попадает в события', () => {
  const s = freshGame();
  const events = applyDmEffects(s, { narrative: 'Тьма хихикает.' });
  assert.ok(events.some(e => e.kind === 'dm' && e.text === 'Тьма хихикает.'));
});
