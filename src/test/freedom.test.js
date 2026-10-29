import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, applyIntent, parseCommand } from '../engine/game.js';
import { createLoopbackNet } from '../net/loopback.js';
import { createHostSession } from '../net/host.js';
import { createClientSession } from '../net/client.js';
import { FREE_COOLDOWN_MS, SAY_COOLDOWN_MS } from '../net/protocol.js';

const tick = (n = 10) => new Promise(r => setTimeout(r, n));
const HERO = { name: 'Дима', className: 'Воин', stats: { str: 16, dex: 12, int: 8, con: 14, cha: 10, luck: 12 } };
const HERO2 = { name: 'Катя', className: 'Плут', stats: { str: 10, dex: 16, int: 12, con: 10, cha: 14, luck: 10 } };

function run(players = [HERO]) {
  return newGame({ seed: 2024, mode: 'sandbox', worldDesc: 'Тестовые катакомбы', players });
}

test('парсер: крик/шёпот — это реплика, а не действие', () => {
  assert.equal(parseCommand('кричу: держите дверь!').intent, 'say');
  assert.equal(parseCommand('кричу: держите дверь!').verb, 'кричит');
  assert.equal(parseCommand('шепчу Кате про ловушку').intent, 'say');
  assert.equal(parseCommand('шепчу Кате про ловушку').verb, 'шепчет');
  assert.equal(parseCommand('бормочу проклятие').verb, 'бормочет');
  assert.equal(parseCommand('shout run!').intent, 'say');
  assert.equal(parseCommand('whisper to the rogue').verb, 'шепчет');
  // текст после глагола сохраняется
  assert.match(parseCommand('кричу: держите дверь!').text, /держите дверь/);
});

test('парсер: разговор с миром остаётся свободным действием для ДМа', () => {
  const it = parseCommand('говорю со стражей о пропуске');
  assert.equal(it.intent, 'free', 'это диалог с НПС, а не чат партии');
  // а вот упоминание торговца — это уже витрина: игрок явно тянется к прилавку
  assert.equal(parseCommand('спрашиваю торговца о цене').intent, 'trade');
  assert.equal(parseCommand('спрашиваю стражу о цене').intent, 'free');
});

test('реплика не тратит ход, не двигает очередь и не будит монстров', () => {
  const s = run([HERO, HERO2]);
  const turn = s.turn;
  const active = s.activeIdx;
  const monstersBefore = JSON.stringify(s.monsters.map(m => [m.x, m.y, m.hp]));
  const evs = applyIntent(s, parseCommand('кричу: я в подвале!'), s.activeIdx);
  assert.equal(s.turn, turn, 'ход не потрачен');
  assert.equal(s.activeIdx, active, 'очередь не сдвинулась');
  assert.equal(JSON.stringify(s.monsters.map(m => [m.x, m.y, m.hp])), monstersBefore, 'монстры не ходили');
  assert.equal(evs[0].kind, 'say');
  assert.match(evs[0].text, /Дима кричит/);
});

test('реплика работает НЕ в свой ход — можно договориться до действия', () => {
  const s = run([HERO, HERO2]);
  s.activeIdx = 1; // ходит Катя
  const evs = applyIntent(s, parseCommand('шепчу: у меня два хита, прикрой'), 0);
  assert.equal(evs.length, 1);
  assert.match(evs[0].text, /Дима шепчет/);
});

test('реплика запоминается ДМу (он слышит партию)', () => {
  const s = run();
  applyIntent(s, parseCommand('кричу: тут ловушка!'), 0);
  assert.ok(s.memory.some(line => /ловушка/.test(line)), 'реплика попала в память ДМа');
});

test('пустая реплика ничего не делает', () => {
  const s = run();
  assert.deepEqual(applyIntent(s, parseCommand('кричу'), 0), []);
  assert.deepEqual(applyIntent(s, { intent: 'say', text: '   ' }, 0), []);
});

test('кулдаун свободного текста — 3 секунды (было 5)', () => {
  assert.equal(FREE_COOLDOWN_MS, 3000);
  assert.ok(SAY_COOLDOWN_MS < FREE_COOLDOWN_MS, 'реплики дешевле вольностей');
});

test('кооп: реплика не в свой ход доходит до всех и не тратит ход', async () => {
  const net = createLoopbackNet();
  const host = createHostSession({ net: net.host, hostName: 'Дима', turnMs: 0 });
  const link = net.spawnClient();
  const client = createClientSession({ link, name: 'Катя' });
  const got = [];
  client.onEvents(e => got.push(...e));
  client.hello();
  await tick();
  host.startGame({
    worldDesc: 'X', mode: 'sandbox',
    classAssignments: [HERO, HERO2],
    intro: async () => ({})
  });
  await tick(30);

  const turnBefore = host.getGame().turn;
  const activeBefore = host.getGame().activeIdx;
  client.sendCommand('кричу: не ходи туда, там слизь');
  await tick(30);

  const texts = got.map(e => e.text).join(' ');
  assert.match(texts, /Катя кричит/, 'реплика дошла клиенту');
  assert.match(texts, /слизь/);
  assert.equal(host.getGame().turn, turnBefore, 'ход не потрачен');
  assert.equal(host.getGame().activeIdx, activeBefore, 'очередь не сдвинулась');
});

test('кооп: спам репликами гасится кулдауном', async () => {
  const net = createLoopbackNet();
  const host = createHostSession({ net: net.host, hostName: 'Дима', turnMs: 0 });
  const link = net.spawnClient();
  const client = createClientSession({ link, name: 'Катя' });
  const got = [];
  client.onEvents(e => got.push(...e));
  client.hello();
  await tick();
  host.startGame({ worldDesc: 'X', mode: 'sandbox', classAssignments: [HERO, HERO2], intro: async () => ({}) });
  await tick(30);

  client.sendCommand('кричу: раз');
  client.sendCommand('кричу: два');
  client.sendCommand('кричу: три');
  await tick(40);
  const says = got.filter(e => e.kind === 'say');
  assert.equal(says.length, 1, `прошла только одна реплика (${says.length})`);
});

test('кооп: свободный текст всё ещё ограничен 3 секундами', async () => {
  const net = createLoopbackNet();
  const host = createHostSession({ net: net.host, hostName: 'Дима', turnMs: 0 });
  const events = [];
  host.onEvents(e => events.push(...e));
  net.spawnClient();
  await tick();
  host.startGame({ worldDesc: 'X', mode: 'sandbox', classAssignments: [HERO], intro: async () => ({}) });
  await tick(30);
  host.localIntent('придумываю что-то странное');
  await tick(30);
  host.localIntent('и ещё одну странность');
  await tick(30);
  assert.match(events.map(e => e.text).join(' '), /ДМ переваривает/);
});
