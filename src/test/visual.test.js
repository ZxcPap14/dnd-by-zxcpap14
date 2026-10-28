// visual.test.js — тесты визуального слоя: аватары и наборы символов карты.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameHash, asciiAvatar } from '../ui/avatar.js';
import { GLYPH_SETS } from '../ui/terminal.js';

test('nameHash: детерминизм и чувствительность к регистру/пробелам', () => {
  assert.equal(nameHash('Дима'), nameHash('Дима'));
  assert.notEqual(nameHash('Дима'), nameHash('дима')); // нормализация в asciiAvatar, не в хэше
  assert.notEqual(nameHash('Дима'), nameHash('Катя'));
  assert.equal(nameHash(''), 2166136261 >>> 0); // пустая строка = FNV offset basis
});

test('asciiAvatar: один ник — один портрет, разные ники почти всегда разные', () => {
  const a1 = asciiAvatar('Дима');
  const a2 = asciiAvatar('Дима');
  const b = asciiAvatar('Катя');
  assert.equal(a1, a2, 'детерминизм');
  assert.notEqual(a1, b, 'разные ники — разные портреты');
  // регистр и пробелы нормализуются
  assert.equal(asciiAvatar('  ДИМА '), a1);
});

test('asciiAvatar: 5 строк × 8 колонок, только допустимые символы, симметрия', () => {
  const ALLOWED = new Set([' ', '.', ':', '~', '=', '+', "'", '^', 'o', '▒', '▓', '█']);
  for (const name of ['Дима', 'Катя', 'Безымянный', 'x', 'КиберПёс2099', '']) {
    const art = asciiAvatar(name);
    const rows = art.split('\n');
    assert.equal(rows.length, 5, `5 строк для "${name}"`);
    for (const row of rows) {
      assert.equal(row.length, 8, `8 колонок для "${name}"`);
      for (const ch of row) assert.ok(ALLOWED.has(ch), `символ "${ch}" из набора`);
      // зеркальная симметрия
      assert.equal(row, [...row].reverse().join(''), 'симметрия');
    }
  }
});

test('asciiAvatar: пустой/undefined ник не падает и детерминирован', () => {
  assert.equal(asciiAvatar(''), asciiAvatar(''));
  assert.equal(asciiAvatar(undefined), asciiAvatar(null));
});

test('GLYPH_SETS: три набора с одинаковой схемой ключей', () => {
  const keys = Object.keys(GLYPH_SETS.classic).sort().join(',');
  for (const name of Object.keys(GLYPH_SETS)) {
    assert.equal(Object.keys(GLYPH_SETS[name]).sort().join(','), keys, `${name}: та же схема`);
    for (const [k, v] of Object.entries(GLYPH_SETS[name])) {
      assert.equal(typeof v, 'string');
      assert.ok(v.length === 1, `${name}.${k} — один глиф`);
    }
  }
  assert.equal(GLYPH_SETS.classic.wall, '#');
  assert.equal(GLYPH_SETS.blocky.wall, '▓');
  assert.notEqual(GLYPH_SETS.pseudo.wall, '#');
});
