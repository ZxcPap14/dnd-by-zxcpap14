// Волна 3: акты сюжета в контексте ДМа и репутация фракций с ценами.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, applyDmEffects, actBrief, addRep, repDigest, repPriceMult } from '../engine/game.js';
import { buildContext } from '../ai/dm.js';
import { openMerchant } from '../engine/merchant.js';

const freshGame = (seed = 7) => newGame({ seed, worldDesc: 'Гнилой порт', className: 'Вор', name: 'Кай' });

test('actBrief: завязка, сгущение и финал звучат по-разному', () => {
  const st = { story: { act: 1, acts: 3 } };
  assert.match(actBrief(st), /ЗАВЯЗКИ/);
  st.story.act = 2;
  assert.match(actBrief(st), /СГУЩЕНИЯ/);
  st.story.act = 3;
  assert.match(actBrief(st), /ФИНАЛА/);
  assert.equal(actBrief({ story: null }), '');
});

test('buildContext: ДМ видит требование акта и репутацию', () => {
  const s = freshGame();
  s.story.act = 1;
  addRep(s, 'Портовая стража', 2);
  const text = buildContext(s, 'осматриваюсь').find(m => m.role === 'user').content;
  assert.match(text, /ЧТО НУЖНО ОТ ГЛАВЫ: ГЛАВА ЗАВЯЗКИ/);
  assert.match(text, /РЕПУТАЦИЯ \(мир помнит\): Портовая стража \+2/);
});

test('addRep: копится, ограничено ±5, регистр не плодит дубли', () => {
  const s = freshGame();
  s.factions = [];
  addRep(s, 'Гильдия', 2);
  addRep(s, 'гильдия', 2);
  assert.equal(s.factions.length, 1);
  assert.equal(s.factions[0].rep, 4);
  addRep(s, 'Гильдия', 2);
  assert.equal(s.factions[0].rep, 5, 'потолок +5');
  addRep(s, 'Гильдия', -9);
  assert.equal(s.factions[0].rep, 3, 'шаг ограничен двумя');
  assert.equal(repDigest(s), 'Гильдия +3');
  assert.equal(addRep(s, '   ', 1), null);
});

test('addRep: больше шести фракций не держим', () => {
  const s = freshGame();
  s.factions = [];
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) addRep(s, n, 1);
  assert.equal(s.factions.length, 6);
  assert.ok(!s.factions.some(f => f.name === 'a'), 'самая старая выпала');
});

test('repPriceMult: слава дешевле, дурная слава дороже, без фракций — ровно 1', () => {
  const s = freshGame();
  s.factions = [];
  assert.equal(repPriceMult(s), 1);
  addRep(s, 'x', 2); addRep(s, 'x', 2);
  assert.ok(Math.abs(repPriceMult(s) - 0.88) < 1e-9);
  s.factions = [];
  addRep(s, 'x', -2); addRep(s, 'x', -2);
  assert.ok(Math.abs(repPriceMult(s) - 1.12) < 1e-9);
});

test('торговец: за хорошую репутацию товары дешевле, чем за нейтральную', () => {
  const plain = freshGame(3);
  const known = freshGame(3);
  known.factions = [];
  addRep(known, 'Город', 2); addRep(known, 'Город', 2); addRep(known, 'Город', 2);
  const sum = m => m.stock.reduce((acc, it) => acc + it.price, 0);
  const a = sum(openMerchant(plain));
  const b = sum(openMerchant(known));
  assert.ok(b < a, `со славой ${b} должно быть меньше ${a}`);
});

test('applyDmEffects: repChange двигает репутацию и пишет строку в хронику', () => {
  const s = freshGame();
  s.factions = [];
  const events = applyDmEffects(s, { repChange: { name: 'Культ Ножа', delta: 2, reason: 'вырезал их патруль' } });
  assert.equal(s.factions[0].rep, 2);
  const lore = events.find(e => e.kind === 'lore');
  assert.ok(lore && lore.text.includes('Культ Ножа'), 'событие о репутации есть');
  assert.ok(lore.text.includes('вырезал их патруль'), 'причина сохранена');
});
