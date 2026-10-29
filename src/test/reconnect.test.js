import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoopbackNet } from '../net/loopback.js';
import { createHostSession } from '../net/host.js';
import { createClientSession } from '../net/client.js';
import { newGame } from '../engine/game.js';
import { serializeRun, deserializeRun } from '../engine/save.js';

const tick = (n = 10) => new Promise(r => setTimeout(r, n));

const CLASSES = [
  { name: 'Дима', className: 'Воин', stats: { str: 16, dex: 12, int: 8, con: 14, cha: 10, luck: 12 } },
  { name: 'Катя', className: 'Плут', stats: { str: 10, dex: 16, int: 12, con: 10, cha: 14, luck: 10 } },
  { name: 'Саша', className: 'Волхв', stats: { str: 8, dex: 10, int: 16, con: 12, cha: 14, luck: 12 } }
];

function setup(opts = {}) {
  const net = createLoopbackNet();
  const host = createHostSession({ net: net.host, hostName: 'Дима', turnMs: 0, graceMs: 5000, ...opts });
  return { net, host };
}

function join(net, name) {
  const link = net.spawnClient();
  const client = createClientSession({ link, name });
  const got = { welcome: [], snapshots: [], events: [], lobby: [], start: null, reject: null, kicked: null, close: 0 };
  client.onWelcome(w => got.welcome.push(w));
  client.onLobby(l => got.lobby.push(l));
  client.onSnapshot(s => got.snapshots.push(s));
  client.onEvents(e => got.events.push(...e));
  client.onStart(s => { got.start = s; });
  client.onReject(r => { got.reject = r; });
  client.onKicked(r => { got.kicked = r; });
  client.onClose(() => got.close++);
  client.hello();
  return { link, client, got };
}

async function startedGame(opts = {}) {
  const { net, host } = setup(opts);
  const c1 = join(net, 'Катя');
  const c2 = join(net, 'Саша');
  await tick();
  host.startGame({ worldDesc: 'Катакомбы', mode: 'story', classAssignments: CLASSES, intro: async () => ({}) });
  await tick(40);
  return { net, host, c1, c2 };
}

test('обрыв связи: герой не умирает, а ждёт в списке отсутствующих', async () => {
  const { host, c1 } = await startedGame();
  assert.equal(host.getGame().heroes[1].alive, true);

  c1.link.close();
  await tick();
  assert.equal(host.getGame().heroes[1].alive, true, 'герой жив');
  assert.equal(host.getAbsent().length, 1);
  assert.equal(host.getAbsent()[0].name, 'Катя');
  assert.equal(host.getAbsent()[0].heroIdx, 1);

  const lobby = host.getLobby();
  const offline = lobby.find(p => p.name === 'Катя');
  assert.ok(offline, 'игрок остался в списке лобби');
  assert.equal(offline.offline, true, 'помечен как офлайн');
});

test('возврат по имени: тот же герой, тот же heroIdx, снапшот сразу', async () => {
  const { net, host, c1 } = await startedGame();
  const heroHp = host.getGame().heroes[1].hp;

  c1.link.close();
  await tick();
  assert.equal(host.getAbsent().length, 1);

  const back = join(net, 'Катя');
  await tick(30);

  assert.equal(host.getAbsent().length, 0, 'снят с ожидания');
  assert.equal(back.got.welcome.length, 1, 'получил welcome');
  assert.equal(back.got.welcome[0].resumed, true, 'welcome помечен как возврат');
  assert.equal(back.got.welcome[0].heroIdx, 1, 'тот же слот героя');
  assert.ok(back.got.start, 'получил start (без лобби)');
  assert.ok(back.got.snapshots.length > 0, 'сразу получил снапшот');
  assert.equal(back.got.snapshots.at(-1).you, 1);
  assert.equal(host.getGame().heroes[1].alive, true, 'герой не умер');
  assert.equal(host.getGame().heroes[1].hp, heroHp, 'HP не сбросился');
  assert.ok(back.got.events.some(e => /вернулся/.test(e.text)), 'партия узнала о возвращении');
});

test('возврат: игрок снова может ходить', async () => {
  const { net, host, c1 } = await startedGame();
  c1.link.close();
  await tick();
  const back = join(net, 'Катя');
  await tick(30);

  // уступаем ход Кате: хост «ждёт»
  host.localIntent('постоять');
  await tick(20);
  const active = host.getGame().activeIdx;
  if (active === 1) {
    const before = host.getGame().turn;
    back.client.sendCommand('осмотреться');
    await tick(30);
    assert.ok(host.getGame().turn > before, 'ход Кати принят после переподключения');
  } else {
    // очередь дошла до Саши — просто убеждаемся, что возврат не сломал партию
    assert.ok([0, 1, 2].includes(active));
  }
});

test('возврат под чужим именем: отказ, партия уже идёт', async () => {
  const { net, host, c1 } = await startedGame();
  c1.link.close();
  await tick();

  const stranger = join(net, 'Чужой');
  await tick(20);
  assert.ok(stranger.got.reject, 'получил отказ');
  assert.match(stranger.got.reject.reason, /уже началась/i);
  assert.equal(host.getAbsent().length, 1, 'Катя всё ещё ждёт');
});

test('грейс истёк: герой потерян, вернуться уже нельзя', async () => {
  const { net, host, c1 } = await startedGame({ graceMs: 40 });
  c1.link.close();
  await tick(120);

  assert.equal(host.getAbsent().length, 0, 'ожидание снято');
  assert.equal(host.getGame().heroes[1].alive, false, 'герой потерян');
  assert.match(host.getGame().heroes[1].epitaph, /по-английски/);

  const late = join(net, 'Катя');
  await tick(20);
  assert.ok(late.got.reject, 'опоздавший получает отказ');
});

test('двое потерялись и вернулись — каждый на своё место', async () => {
  const { net, host, c1, c2 } = await startedGame();
  c1.link.close();
  c2.link.close();
  await tick();
  assert.equal(host.getAbsent().length, 2);

  const b2 = join(net, 'Саша');
  await tick(20);
  const b1 = join(net, 'Катя');
  await tick(30);

  assert.equal(b1.got.snapshots.at(-1).you, 1);
  assert.equal(b2.got.snapshots.at(-1).you, 2);
  assert.equal(host.getAbsent().length, 0);
});

test('повторный вход в лобби до старта — обычный, без путаницы имён', async () => {
  const { net, host } = setup();
  const a = join(net, 'Катя');
  await tick();
  const b = join(net, 'Катя'); // тёзка
  await tick();
  const names = host.getLobby().map(p => p.name);
  assert.equal(new Set(names).size, names.length, 'имена уникальны: ' + names.join(', '));
  assert.ok(a.got.lobby.length && b.got.lobby.length);
});

test('тёзки: хост выдаёт разные имена и пускает обратно именно по ним', async () => {
  const { net, host } = setup();
  const a = join(net, 'Петя');
  await tick();
  const b = join(net, 'Петя');
  await tick();

  const nameA = a.got.welcome[0].name;
  const nameB = b.got.welcome[0].name;
  assert.equal(nameA, 'Петя', 'первый остаётся Петей');
  assert.notEqual(nameA, nameB, 'второй получил суффикс: ' + nameB);

  host.startGame({ worldDesc: 'X', mode: 'story', classAssignments: CLASSES, intro: async () => ({}) });
  await tick(40);

  a.link.close();
  b.link.close();
  await tick();
  assert.equal(host.getAbsent().length, 2);

  // возврат по ВЫДАННЫМ именам — иначе тёзка увёл бы чужой слот
  const a2 = join(net, nameA);
  await tick(20);
  const b2 = join(net, nameB);
  await tick(30);

  assert.equal(a2.got.snapshots.at(-1).you, 1);
  assert.equal(b2.got.snapshots.at(-1).you, 2);
  assert.equal(host.getAbsent().length, 0);
});

test('хост продолжил сохранённый забег: клиенты возвращаются по именам', async () => {
  // «вчерашний» забег: два героя, сохранён в JSON и загружен заново
  const saved = newGame({
    seed: 2026, mode: 'story', worldDesc: 'Катакомбы',
    players: [CLASSES[0], CLASSES[1]]
  });
  saved.turn = 33;
  saved.heroes[0].gold = 120;
  const restored = deserializeRun(JSON.parse(JSON.stringify(serializeRun(saved, { coop: true, room: 'QWER' }))));
  assert.ok(restored);

  const net = createLoopbackNet();
  const host = createHostSession({ net: net.host, hostName: 'Дима', turnMs: 0, graceMs: 5000 });
  const hostSnaps = [];
  host.onSnapshot(s => hostSnaps.push(s));

  assert.equal(host.resumeGame(restored), true);
  assert.equal(host.isStarted(), true);
  assert.equal(host.getGame().turn, 33);
  assert.equal(host.getAbsent().length, 1, 'Катя ждёт возвращения');
  assert.ok(hostSnaps.length > 0, 'хост сразу получил свой снапшот');

  const back = join(net, 'Катя');
  await tick(30);
  assert.equal(back.got.welcome[0].resumed, true);
  assert.equal(back.got.snapshots.at(-1).you, 1);
  assert.equal(back.got.snapshots.at(-1).self.gold, 0);
  assert.equal(host.getGame().turn, 33, 'состояние на месте');
});

test('resumeGame не запускается поверх живой партии', async () => {
  const { host } = await startedGame();
  const other = newGame({ seed: 1, mode: 'sandbox', worldDesc: 'X', players: [CLASSES[0]] });
  assert.equal(host.resumeGame(other), false, 'второй старт отклонён');
});

test('протокол: версия поднята — старые клиенты получат внятный отказ', async () => {
  const { net } = setup();
  const link = net.spawnClient();
  const rejects = [];
  link.onMessage(msg => { if (msg && msg.t === 'reject') rejects.push(msg); });
  link.send({ t: 'hello', ver: 'mp1', name: 'Древний' });
  await tick(20);
  assert.equal(rejects.length, 1);
  assert.match(rejects[0].reason, /версии/i);
});
