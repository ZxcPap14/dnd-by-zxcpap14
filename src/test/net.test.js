import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoopbackNet, makeRoomCode } from '../net/loopback.js';
import { createHostSession } from '../net/host.js';
import { createClientSession } from '../net/client.js';
import { PROTOCOL_VER } from '../net/protocol.js';
import { describePeerError } from '../net/peer.js';

const CLASSES = [
  { name: 'Воин', className: 'Воин', stats: { str: 16, dex: 12, int: 8, con: 14, cha: 10, luck: 12 } },
  { name: 'Плут', className: 'Плут', stats: { str: 10, dex: 16, int: 12, con: 10, cha: 14, luck: 10 } },
  { name: 'Волхв', className: 'Волхв', stats: { str: 8, dex: 10, int: 16, con: 12, cha: 14, luck: 12 } }
];

const tick = (n = 10) => new Promise(r => setTimeout(r, n));

function setup(hostName = 'Дима', opts = {}) {
  const net = createLoopbackNet();
  const host = createHostSession({ net: net.host, hostName, turnMs: 0, ...opts });
  return { net, host };
}

function spawnClient(net, host, name) {
  const link = net.spawnClient();
  const client = createClientSession({ link, name });
  const got = { lobby: [], events: [], snapshots: [], start: null, reject: null };
  client.onLobby(l => got.lobby.push(l));
  client.onEvents(e => got.events.push(e));
  client.onSnapshot(s => got.snapshots.push(s));
  client.onStart(s => { got.start = s; });
  client.onReject(r => { got.reject = r; });
  client.hello();
  return { link, client, got };
}

test('describePeerError: сырые типы PeerJS превращаются в понятные тексты', () => {
  assert.match(describePeerError('network'), /Сигнальный сервер недоступен/);
  assert.match(describePeerError('server-error'), /временно сбоит/);
  assert.match(describePeerError('unavailable-id'), /уже занят/);
  assert.match(describePeerError('peer-unavailable'), /не найдена/);
  assert.match(describePeerError('timeout', 'нет пинга'), /не отвечает: нет пинга/);
  assert.match(describePeerError('что-то новое'), /что-то новое/);
  // без точки в конце сообщений-инструкций
  assert.ok(describePeerError('network').endsWith('ещё раз.'));
});

test('makeRoomCode: 4 символа из безопасного алфавита', () => {
  const code = makeRoomCode();
  assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
});

test('полный цикл: лобби → старт → снапшоты всем → ходы по очереди', async () => {
  const { net, host } = setup();
  const c1 = spawnClient(net, host, 'Катя');
  const c2 = spawnClient(net, host, 'Саша');
  await tick();

  assert.ok(host.getLobby().length === 3, 'хост + 2 клиента в лобби');
  assert.deepEqual(c1.got.lobby.at(-1).map(p => p.name).sort(), ['Дима', 'Катя', 'Саша']);
  assert.ok(c1.got.lobby.at(-1)[0].host === true);

  let hostSnaps = 0, hostEvents = 0;
  host.onSnapshot(() => hostSnaps++);
  host.onEvents(() => hostEvents++);

  host.startGame({
    worldDesc: 'Тёмные земли', mode: 'story',
    classAssignments: CLASSES,
    intro: async () => ({ narrative: 'Вы все очнулись в яме. Классика.' })
  });
  await tick(30);

  assert.ok(host.isStarted());
  assert.ok(c1.got.start, 'клиент получил start');
  assert.ok(c1.got.snapshots.length > 0, 'клиенту пришёл снапшот');
  assert.equal(c1.got.snapshots.at(-1).you, 1);
  assert.equal(c2.got.snapshots.at(-1).you, 2);
  assert.ok(c1.got.events.some(evs => evs.some(e => e.text.includes('яме'))), 'интро дошло клиенту');
  assert.ok(hostEvents > 0, 'интро дошло до UI хоста');
  assert.ok(hostSnaps > 0);

  // ход хоста (игрок 0) — потом клиент 1, потом клиент 2
  const idx0 = host.getGame().activeIdx;
  host.localIntent('постоять');
  await tick();
  assert.equal(host.getGame().activeIdx, (idx0 + 1) % 3);

  c1.client.sendCommand('постоять');
  await tick();
  assert.equal(host.getGame().activeIdx, (idx0 + 2) % 3);

  // попытка походить не в свою очередь
  const before = host.getGame().turn;
  c1.client.sendCommand('постоять');
  await tick();
  assert.equal(host.getGame().turn, before, 'ход не потрачен');
  const lastEv = c1.got.events.at(-1).flat().map(e => e.text).join(' ');
  assert.match(lastEv, /не твой ход/i);
});

test('свободный текст уходит в ДМ и доходит всем', async () => {
  const { net, host } = setup();
  const c1 = spawnClient(net, host, 'Катя');
  await tick();
  host.startGame({
    worldDesc: 'X', mode: 'story', classAssignments: CLASSES.slice(0, 2),
    intro: async () => ({ narrative: 'Начало.' })
  });
  await tick(30);

  // уступить ход Кате, чтобы свободный текст был именно её
  host.localIntent('постоять');
  await tick();

  c1.client.sendCommand('пробую подкупить богов тортом');
  await tick(30);
  const texts = c1.got.events.flat().map(e => e.text).join(' ');
  // свободный текст должен был уйти в заглушку-ДМ и вернуться содержательным ответом
  assert.ok(texts.length > 40, 'ответ ДМа дошёл клиенту');
});

test('кулдаун свободного текста: вторая вольность сразу — отказ', async () => {
  const { net, host } = setup();
  spawnClient(net, host, 'Катя');
  await tick();
  const hostEvents = [];
  host.onEvents(e => hostEvents.push(...e));
  host.startGame({ worldDesc: 'X', mode: 'story', classAssignments: CLASSES.slice(0, 2), intro: async () => ({}) });
  await tick(30);

  // хост шлёт две вольности подряд: кулдаун проверяется ДО очереди хода
  host.localIntent('вольничаю раз'); await tick(30);
  host.localIntent('вольничаю два'); await tick(30);
  const allText = hostEvents.map(e => e.text).join(' ');
  assert.match(allText, /ДМ переваривает/, 'кулдаун сработал');
});

test('мусорные сообщения не роняют хост', async () => {
  const { net, host } = setup();
  spawnClient(net, host, 'Катя');
  await tick();
  const evil = net.spawnClient();
  evil.send(null);
  evil.send({ t: 'hello' });
  evil.send({ t: 'intent' });
  evil.send({ t: 'intent', command: 42 });
  evil.send('строка');
  evil.send({ t: 'hello', ver: 'древняя', name: 'Древний' });
  await tick();
  assert.ok(host.getLobby().length >= 1);
});

test('reject: полная комната (хост + 4)', async () => {
  const { net, host } = setup();
  for (let i = 0; i < 4; i++) { spawnClient(net, host, 'Игрок' + i); await tick(); }
  const extra = net.spawnClient();
  const client5 = createClientSession({ link: extra, name: 'Пятый' });
  const rejects = [];
  client5.onReject(r => rejects.push(r));
  client5.hello();
  await tick();
  assert.ok(rejects.length === 1, 'комната полна (макс 4)');
  assert.match(rejects[0].reason, /полна/);
});

test('вышедший клиент: герой ждёт переподключения, а потом умирает с эпитафией', async () => {
  const { net, host } = setup('Дима', { graceMs: 40 });
  const c1 = spawnClient(net, host, 'Катя');
  await tick();
  host.startGame({ worldDesc: 'X', mode: 'story', classAssignments: CLASSES.slice(0, 2), intro: async () => ({}) });
  await tick(30);
  assert.equal(host.getGame().heroes[1].alive, true);

  c1.link.close();
  await tick();
  assert.equal(host.getGame().heroes[1].alive, true, 'сразу не убиваем — ждём возвращения');
  assert.equal(host.getAbsent().length, 1, 'герой в списке ожидающих');
  assert.match(host.getAbsent()[0].name, /Катя/);

  await tick(120);
  assert.equal(host.getGame().heroes[1].alive, false, 'после грейса герой потерян');
  assert.match(host.getGame().heroes[1].epitaph, /по-английски/);
  assert.equal(host.getGame().over, false, 'партия жива, пока жив хост');
});

test('эхо сообщений видно ВСЕМ игрокам, с именем автора', async () => {
  const { net, host } = setup();
  const c1 = spawnClient(net, host, 'Катя');
  const c2 = spawnClient(net, host, 'Саша');
  await tick();
  host.startGame({ worldDesc: 'X', mode: 'story', classAssignments: CLASSES, intro: async () => ({}) });
  await tick(30);

  host.localIntent('проверяю эхо');   // пишет хост (Дима)
  await tick();
  c1.client.sendCommand('и Катя пишет'); // пишет Катя (её ход)
  await tick(30);

  // у КАЖДОГО участника в событиях видны сообщения обоих
  const c1Texts = c1.got.events.flat().map(e => `${e.kind}|${e.text}`).join('\n');
  const c2Texts = c2.got.events.flat().map(e => `${e.kind}|${e.text}`).join('\n');
  assert.match(c1Texts, /player\|Дима: проверяю эхо/, 'Катя видит сообщение Димы');
  assert.match(c1Texts, /player\|Катя: и Катя пишет/, 'Катя видит своё');
  assert.match(c2Texts, /player\|Дима: проверяю эхо/, 'Саша видит сообщение Димы');
  assert.match(c2Texts, /player\|Катя: и Катя пишет/, 'Саша видит сообщение Кати');
});

test('стресс: 500 команд через сеть, seq монотонный, хост жив', async () => {
  const { net, host } = setup();
  const c1 = spawnClient(net, host, 'Катя');
  await tick();
  host.startGame({ worldDesc: 'X', mode: 'sandbox', classAssignments: CLASSES.slice(0, 2), intro: async () => ({}) });
  await tick(30);
  const cmds = ['иду на север', 'иду на юг', 'иду на восток', 'иду на запад', 'атакую', 'постоять', 'осмотреться'];
  let seq = 0, bad = 0;
  c1.client.onSnapshot(s => { if (s.seq <= seq) bad++; seq = Math.max(seq, s.seq || 0); });
  for (let i = 0; i < 500; i++) {
    if (i % 2 === 0) host.localIntent(cmds[i % cmds.length]);
    else c1.client.sendCommand(cmds[(i + 1) % cmds.length]);
    if (i % 25 === 0) await tick();
  }
  await tick(50);
  assert.equal(bad, 0, 'seq монотонный');
  assert.ok(host.getGame(), 'хост жив');
});
