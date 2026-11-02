// Мир придумывает игрок: классы и злодей выводятся из слов названия и описания.
import test from 'node:test';
import assert from 'node:assert/strict';
import { worldWords, classesFromWorld, villainFromWorld } from '../engine/world.js';
import { newGame } from '../engine/game.js';
import { buildContext } from '../ai/dm.js';

test('worldWords: имя собственное вперёд, служебные слова и цифры отброшены', () => {
  const w = worldWords('Дождь над Порт-Альгеном: соль, долги, чужие имена, 1947 год');
  assert.equal(w[0], 'портальгеном', 'имя собственное идёт первым: ' + w.join(','));
  assert.ok(!w.includes('над') && !w.includes('год'), 'служебные слова отброшены');
  assert.ok(w.includes('долги') && w.includes('имена'));
  assert.deepEqual(worldWords(''), [], 'пустой мир — пустой список слов');
});

test('classesFromWorld: три класса, имена — из слов этого мира', () => {
  const a = classesFromWorld('Нуар-город 1947: дождь, долги, частный детектив');
  const b = classesFromWorld('Грузовой корабль «Атлас»: орбита, экипаж врёт');
  assert.equal(a.length, 3);
  for (const c of a) {
    assert.ok(c.name && c.desc, 'имя и описание');
    assert.equal(Object.keys(c.stats).length, 6);
    assert.ok(Object.values(c.stats).every(v => v >= 8 && v <= 16));
    assert.ok(c.ability.active && c.ability.passive);
  }
  assert.notEqual(a[0].name, b[0].name, 'два разных мира — разные классы');
  assert.notDeepEqual(a.map(c => c.name).sort(), ['Боец', 'Говорун', 'Хитрец'].sort());
});

test('classesFromWorld: пустой мир даёт нейтральные классы, а не падение', () => {
  const list = classesFromWorld('');
  assert.equal(list.length, 3);
  assert.ok(list.every(c => c.name.length > 2));
});

test('villainFromWorld: злодей собран из слов мира', () => {
  const v = villainFromWorld('Пустошь после бензина: цистерны, радиация', () => 0.1);
  assert.match(v.villain, /«.+»/);
  assert.match(v.goal, /«.+»/);
  assert.ok(worldWords('Пустошь после бензина: цистерны, радиация').some(w => v.villain.toLowerCase().includes(w)));
  const empty = villainFromWorld('', () => 0.5);
  assert.ok(empty.villain.length > 3 && empty.goal.length > 3);
});

test('история делится на главы, а не на акты', () => {
  const st = newGame({ seed: 3, worldDesc: 'Дождь над Порт-Альгеном: соль, долги', className: 'Странник', name: 'Дима' });
  const text = buildContext(st, 'осмотреться').map(m => m.content).join('\n');
  assert.match(text, /ГЛАВА 1\/3/);
  assert.match(text, /ЧТО НУЖНО ОТ ГЛАВЫ/);
  assert.ok(!/АКТ \d/.test(text) && !/ОТ АКТА/.test(text), 'глав без старых актов');
});
