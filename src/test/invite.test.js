// Ссылка-приглашение: код комнаты из адреса.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInvite } from '../ui/store.js';

test('parseInvite: код из ссылки, регистр не важен', () => {
  assert.equal(parseInvite('?join=ab12'), 'AB12');
  assert.equal(parseInvite('?relay=x&join=QWER'), 'QWER');
});

test('parseInvite: битая ссылка не ломает запуск', () => {
  assert.equal(parseInvite(''), null);
  assert.equal(parseInvite('?join='), null);
  assert.equal(parseInvite('?join=ABC'), null);
  assert.equal(parseInvite('?join=ABCDE'), null);
  assert.equal(parseInvite('?join=AB$1'), null);
  assert.equal(parseInvite('?other=1'), null);
  assert.equal(parseInvite(undefined), null);
});
