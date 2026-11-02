import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../src/ui/store.js', import.meta.url), 'utf8');

test('архив: сводка считает забеги, лучший этаж и победы', async () => {
  const { hofStats } = await import('../ui/store.js');
  assert.deepEqual(hofStats([]), { runs: 0, best: 0, wins: 0 });

  const list = [
    { name: 'А', depth: 3, won: false },
    { name: 'Б', depth: 9, won: true },
    { name: 'В', depth: 1, won: false },
    { name: 'Г', depth: 5, won: true }
  ];
  assert.deepEqual(hofStats(list), { runs: 4, best: 9, wins: 2 });
});

test('архив: мусор в хранилище не ломает сводку', async () => {
  const { hofStats } = await import('../ui/store.js');
  assert.deepEqual(hofStats(null), { runs: 0, best: 0, wins: 0 });
  assert.deepEqual(hofStats([null, {}, { depth: 'x' }]), { runs: 2, best: 0, wins: 0 });
});

test('архив: hofStats экспортируется из store.js', () => {
  assert.match(src, /export function hofStats/);
});
