// Классы хоста: новый игрок играет по миру и классам того, кто платит за ИИ.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostSession } from '../net/host.js';
import { createClientSession } from '../net/client.js';
import { PROTOCOL_VER } from '../net/protocol.js';

function fakeNet() {
  let onMsg = null;
  const sent = [];
  return {
    sent,
    net: {
      broadcast: msg => sent.push(['all', msg]),
      sendTo: (id, msg) => sent.push([id, msg]),
      onClientMessage: fn => { onMsg = fn; },
      onClientJoin: () => {},
      onClientLeave: () => {}
    },
    send: (id, msg) => onMsg(id, msg)
  };
}

test('хост отдаёт свои классы вошедшему игроку', async () => {
  const { net, sent, send } = fakeNet();
  createHostSession({
    net,
    hostName: 'Хост',
    getClasses: () => ({
      world: 'Дождь над Порт-Альгеном: соль, долги',
      classes: [{ name: 'Соль', desc: 'держит удар', stats: {}, ability: null }]
    })
  });

  await send('c1', { t: 'hello', ver: PROTOCOL_VER, name: 'Дима' });

  const msg = sent.map(([, m]) => m).find(m => m && m.t === 'classes');
  assert.ok(msg, 'вошедшему не пришли классы');
  assert.equal(msg.classes[0].name, 'Соль');
  assert.match(msg.world, /Порт-Альгеном/);
});

test('клиент принимает классы хоста через onClasses', () => {
  let onMsg = null;
  const link = {
    send() {},
    onMessage: fn => { onMsg = fn; },
    onClose: () => {},
    close() {}
  };
  const sess = createClientSession({ link, name: 'Дима', heartbeatMs: 0 });
  let got = null;
  sess.onClasses(x => { got = x; });

  onMsg({ t: 'classes', world: 'Мир', classes: [{ name: 'Неон' }] });
  assert.equal(got.world, 'Мир');
  assert.equal(got.classes[0].name, 'Неон');
});
