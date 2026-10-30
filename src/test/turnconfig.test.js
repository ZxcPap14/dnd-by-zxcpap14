// turnconfig.test.js — пользовательский TURN: нормализация, сохранение, ICE-список.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTurn, saveCustomTurn, loadCustomTurn, clearCustomTurn, iceServers
} from '../net/turnconfig.js';

test('normalizeTurn: валидный turn принимается, мусор отбрасывается', () => {
  assert.equal(normalizeTurn({ urls: 'turn:h:3478', username: 'u', credential: 'p' }).urls[0], 'turn:h:3478');
  assert.equal(normalizeTurn({ urls: ['turn:a', 'sturn:не-turn', 'turns:b'], username: 'u', credential: 'p' }).urls.length, 2);
  assert.equal(normalizeTurn({ urls: 'turn:h:3478' }), null); // нет логина/пароля
  assert.equal(normalizeTurn({ urls: 'https://h', username: 'u', credential: 'p' }), null); // не turn:
  assert.equal(normalizeTurn(null), null);
  assert.equal(normalizeTurn('просто строка'), null);
});

test('saveCustomTurn: формат «url|user|pass», несколько url, очистка', () => {
  clearCustomTurn();
  assert.equal(loadCustomTurn(), null);

  const res = saveCustomTurn('turn:h:3478?transport=tcp|u|p');
  assert.ok(res.ok);
  assert.equal(loadCustomTurn().urls[0], 'turn:h:3478?transport=tcp');
  assert.equal(loadCustomTurn().username, 'u');

  assert.equal(saveCustomTurn('turn:a,turns:b|u|p').turn.urls.length, 2);

  // битый ввод не затирает уже сохранённое значение
  assert.ok(!saveCustomTurn('мусор без палок').ok);
  assert.equal(loadCustomTurn().urls.length, 2);

  // JSON-формат тоже принимается
  assert.ok(saveCustomTurn('{"urls":["turn:j:443"],"username":"ju","credential":"jp"}').ok);
  assert.equal(loadCustomTurn().username, 'ju');

  // пустая строка — осознанный сброс, а не ошибка
  assert.ok(saveCustomTurn('').ok);
  assert.equal(loadCustomTurn(), null);
});

test('iceServers: без TURN — только STUN, с TURN — плюс пользовательский', () => {
  clearCustomTurn();
  assert.equal(iceServers().length, 1);

  saveCustomTurn('turn:h:3478|u|p');
  const ice = iceServers();
  assert.equal(ice.length, 2);
  assert.equal(ice[0].urls[0], 'stun:stun.l.google.com:19302');
  assert.deepEqual(ice[1], { urls: ['turn:h:3478'], username: 'u', credential: 'p' });

  clearCustomTurn();
});
