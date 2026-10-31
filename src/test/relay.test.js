// Реальный сервер релея (тот же код комнаты, что и в воркере) + реальные
// WebSocket-клиенты: проверяем именно то, что ломалось у игроков в разных
// сетях — вход в лобби через релей, без WebRTC.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createHostSession } from '../net/host.js';
import { createClientSession } from '../net/client.js';
import { createRelayHostNet, createRelayClientLink, loadRelayUrl, saveRelayUrl, roomUrl } from '../net/relay.js';
import { Room } from '../net/relayroom.js';

const CLASSES = [
  { name: 'Воин', className: 'Воин', stats: { str: 16, dex: 12, int: 8, con: 14, cha: 10, luck: 12 } },
  { name: 'Плут', className: 'Плут', stats: { str: 10, dex: 16, int: 12, con: 10, cha: 14, luck: 10 } },
  { name: 'Волхв', className: 'Волхв', stats: { str: 8, dex: 10, int: 16, con: 12, cha: 14, luck: 12 } }
];

const rooms = new Map();
const http = createServer((req, res) => { res.writeHead(200); res.end('ok'); });
const wss = new WebSocketServer({ noServer: true });

http.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://relay');
  const m = url.pathname.match(/^\/room\/([^/]+)\/?$/);
  if (!m) { socket.destroy(); return; }
  const code = decodeURIComponent(m[1]).toLowerCase();
  wss.handleUpgrade(req, socket, head, ws => {
    let room = rooms.get(code);
    if (!room) {
      room = new Room({ onEmpty: () => rooms.delete(code) });
      rooms.set(code, room);
    }
    const sock = {
      id: url.searchParams.get('id') || 'anon',
      send: obj => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); },
      close: () => { try { ws.close(); } catch { /* ignore */ } }
    };
    ws.on('message', raw => room.receive(sock, raw.toString()));
    ws.on('close', () => room.detach(sock));
    room.attach(url.searchParams.get('role') === 'host' ? 'host' : 'client', sock.id, sock);
  });
});

await new Promise(r => http.listen(0, '127.0.0.1', r));
const RELAY = `http://127.0.0.1:${http.address().port}`;

after(async () => {
  for (const room of rooms.values()) room.checkEmpty();
  wss.close();
  await new Promise(r => http.close(r));
});

const code = () => Math.random().toString(36).slice(2, 6).toUpperCase();

async function waitFor(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('не дождались условия за ' + ms + ' мс');
}

async function hostRoom(room = code()) {
  const hostNet = await createRelayHostNet(room, { relayUrl: RELAY });
  const host = createHostSession({ net: hostNet, hostName: 'Хост', turnMs: 0 });
  return { room, hostNet, host };
}

async function join(room, name) {
  const link = await createRelayClientLink(room, { relayUrl: RELAY });
  const client = createClientSession({ link, name });
  const got = { lobby: [], snapshots: [], events: [], start: null, welcome: null };
  client.onLobby(l => got.lobby.push(l));
  client.onSnapshot(s => got.snapshots.push(s));
  client.onEvents(e => got.events.push(e));
  client.onStart(s => { got.start = s; });
  client.onWelcome(w => { got.welcome = w; });
  client.hello();
  return { link, client, got };
}

test('релей: игрок входит в лобби к хосту и стартует партию', async (t) => {
  const { room, host } = await hostRoom();
  t.after(() => host.stop());
  const c = await join(room, 'Гость');
  t.after(() => c.client.close());
  await waitFor(() => host.getLobby().length === 2 && c.got.lobby.length > 0);

  assert.deepEqual(host.getLobby().map(p => p.name).sort(), ['Гость', 'Хост']);
  assert.equal(c.got.lobby.at(-1)[0].host, true);

  host.startGame({
    worldDesc: 'Тёмные земли', mode: 'story', classAssignments: CLASSES.slice(0, 2),
    intro: async () => ({ narrative: 'Вы очнулись в яме.' })
  });
  await waitFor(() => c.got.start && c.got.snapshots.length > 0);
  assert.equal(c.got.snapshots.at(-1).you, 1);

  // ход хоста → ход гостя, команда реально доходит через релей
  host.localIntent('постоять');
  await waitFor(() => host.getGame().activeIdx === 1);
  c.client.sendCommand('постоять');
  await waitFor(() => host.getGame().activeIdx === 0);
  assert.equal(host.getGame().turn > 0, true);
});

test('релей: два игрока получают персональные снапшоты', async (t) => {
  const { room, host } = await hostRoom();
  t.after(() => host.stop());
  const c1 = await join(room, 'Катя');
  const c2 = await join(room, 'Саша');
  t.after(() => { c1.client.close(); c2.client.close(); });
  await waitFor(() => host.getLobby().length === 3);

  host.startGame({ worldDesc: 'X', mode: 'sandbox', classAssignments: CLASSES, intro: async () => ({}) });
  await waitFor(() => c1.got.snapshots.length && c2.got.snapshots.length);
  assert.equal(c1.got.snapshots.at(-1).you, 1);
  assert.equal(c2.got.snapshots.at(-1).you, 2);

  // каждый видит события всех
  host.localIntent('постоять');
  await waitFor(() => c1.got.events.length + c2.got.events.length >= 2);
  assert.ok(c1.got.events.flat().length > 0);
  assert.ok(c2.got.events.flat().length > 0);
});

test('релей: переподключение по имени возвращает героя в лобби', async (t) => {
  const { room, host } = await hostRoom();
  t.after(() => host.stop());
  const c1 = await join(room, 'Катя');
  await waitFor(() => host.getLobby().length === 2);
  host.startGame({ worldDesc: 'X', mode: 'sandbox', classAssignments: CLASSES.slice(0, 2), intro: async () => ({}) });
  await waitFor(() => c1.got.snapshots.length > 0);
  const heroIdx = c1.got.snapshots.at(-1).you;

  c1.link.close();
  await waitFor(() => host.getAbsent().length === 1);
  assert.match(host.getAbsent()[0].name, /Катя/);

  const link2 = await createRelayClientLink(room, { relayUrl: RELAY });
  const c2 = createClientSession({ link: link2, name: 'Катя' });
  t.after(() => c2.close());
  const snaps = [];
  c2.onSnapshot(s => snaps.push(s));
  c2.hello(heroIdx);
  await waitFor(() => host.getLobby().length === 2 && snaps.length > 0);
  assert.equal(snaps.at(-1).you, heroIdx);
  assert.equal(host.getAbsent().length, 0);
});

test('релей: адрес проверяется, сохраняется и сбрасывается', async () => {
  assert.equal(loadRelayUrl(), '');
  assert.equal(saveRelayUrl('просто текст').ok, false);
  assert.equal(saveRelayUrl('https://dnd-relay.example.workers.dev').ok, true);
  assert.equal(loadRelayUrl(), 'https://dnd-relay.example.workers.dev');
  saveRelayUrl('');
  assert.equal(loadRelayUrl(), '');
});

test('релей: https-адрес превращается в wss, код комнаты — в путь', () => {
  assert.equal(
    roomUrl('https://dnd-relay.example.workers.dev/', 'ab12', 'host', 'h-1'),
    'wss://dnd-relay.example.workers.dev/room/ab12?role=host&id=h-1'
  );
  // локальный сервер в тестах и на своём VPS без TLS
  assert.equal(
    roomUrl('http://127.0.0.1:9001', 'AB12', 'client', 'c-2'),
    'ws://127.0.0.1:9001/room/ab12?role=client&id=c-2'
  );
});

test('релей: без хоста — внятная ошибка, а не зависание', async () => {
  await assert.rejects(
    createRelayClientLink(code(), { relayUrl: RELAY, hostWaitMs: 1200 }),
    /Хост не найден через релей/
  );
});

test('релей: игрок, ждавший хоста, получает его без переподключения', async (t) => {
  const room = code();
  const waiting = createRelayClientLink(room, { relayUrl: RELAY, hostWaitMs: 5000 });
  await new Promise(r => setTimeout(r, 300)); // клиент уже сидит в комнате, хоста ещё нет
  const hostNet = await createRelayHostNet(room, { relayUrl: RELAY });
  t.after(() => hostNet.close());
  const link = await waiting;
  t.after(() => link.close());
  assert.equal(link.transport, 'relay');
});
