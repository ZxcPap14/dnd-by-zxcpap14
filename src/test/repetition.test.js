import test from 'node:test';
import assert from 'node:assert/strict';

import { stubDmTurn, resetStub } from '../ai/stub.js';
import { createRng } from '../engine/rng.js';

function bigrams(text) {
  const w = (text.toLowerCase().match(/[а-яё]{3,}/g) || []);
  return new Set(w.slice(1).map((x, i) => w[i] + ' ' + x));
}

/** Доля общих пар слов: одиночные общие слова не считаем повтором. */
function overlap(a, b) {
  const wa = bigrams(a);
  const wb = bigrams(b);
  if (!wa.size || !wb.size) return 0;
  let hit = 0;
  for (const w of wa) if (wb.has(w)) hit++;
  return hit / Math.min(wa.size, wb.size);
}

test('заглушка-ДМ: 60 ходов без повторов подряд и без зацикливания', () => {
  resetStub();
  const state = { rng: createRng(11), heroes: [{ name: 'Дима', equipment: {} }], activeIdx: 0, depth: 1, over: false, memory: [] };
  const texts = [];
  for (let i = 0; i < 60; i++) {
    const eff = stubDmTurn(state, 'осмотреться');
    texts.push(eff.narrative);
  }
  for (let i = 1; i < texts.length; i++) {
    assert.notEqual(texts[i], texts[i - 1], 'две одинаковые реплики подряд на ходу ' + i);
    assert.ok(overlap(texts[i], texts[i - 1]) < 0.6, 'слишком похожие ходы ' + (i - 1) + ' и ' + i);
  }
  const uniq = new Set(texts).size;
  assert.ok(uniq >= 8, 'за 60 ходов всего ' + uniq + ' разных реплик');
});
