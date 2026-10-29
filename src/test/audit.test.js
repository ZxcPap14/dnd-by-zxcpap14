// audit.test.js — регрессии на баги, найденные при вычитке всего кода.
// Каждый тест здесь — конкретная поломка, которая уже случалась (или случилась бы).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { newGame, parseCommand, applyIntent, applyDmEffects, resolveCombatRound } from '../engine/game.js';
import { makeItem, gainXp, createPlayer } from '../engine/player.js';
import { serializeRun, deserializeRun } from '../engine/save.js';
import { createRng } from '../engine/rng.js';
import { rollDrop, BASIC_DROP_TABLE } from '../engine/combat.js';
import { createHostSession } from '../net/host.js';
import { createClientSession } from '../net/client.js';
import { createLoopbackNet } from '../net/loopback.js';
import { firstSuccess } from '../net/hybrid.js';

const tick = (n = 10) => new Promise(r => setTimeout(r, n));

const HERO = { name: 'Дима', className: 'Воин', stats: { str: 16, dex: 12, int: 8, con: 14, cha: 10, luck: 12 } };
const HERO2 = { name: 'Катя', className: 'Плут', stats: { str: 10, dex: 16, int: 12, con: 10, cha: 14, luck: 10 } };

function twoHeroGame(seed = 12345) {
  return newGame({ seed, mode: 'sandbox', worldDesc: 'Тёмные земли', players: [HERO, HERO2] });
}

// ---------- парсер ----------

test('парсер: «оружие» — не реплика в чат', () => {
  // стем «ору» с хвостом ловил «оружие»: «надеваю оружие» превращалось в крик «жие»
  const equip = parseCommand('надеваю оружие');
  assert.notEqual(equip.intent, 'say');
  assert.equal(equip.intent, 'equip');

  assert.notEqual(parseCommand('кладу оружие в сумку').intent, 'say');
  assert.notEqual(parseCommand('осматриваю оружие').intent, 'say');
});

test('парсер: настоящие реплики по-прежнему работают', () => {
  const shout = parseCommand('кричу: держись, я иду!');
  assert.equal(shout.intent, 'say');
  assert.match(shout.text, /держись/);
  assert.equal(shout.verb, 'кричит');

  assert.equal(parseCommand('шепчу напарнику: сзади').intent, 'say');
  assert.equal(parseCommand('ору благим матом').intent, 'say');
  assert.equal(parseCommand('shout run').intent, 'say');
});

test('парсер: пустая реплика не рождает события', () => {
  const state = twoHeroGame();
  const events = applyIntent(state, parseCommand('кричу'), 0);
  assert.deepEqual(events, []);
});

// ---------- очередь ходов ----------

test('DM убил активного героя в коопе — очередь идёт дальше, а не виснет', () => {
  const state = twoHeroGame();
  state.activeIdx = 0;
  state.heroes[0].hp = 2;
  state.heroes[0].maxHp = 20;
  state.heroes[1].hp = 20;
  state.heroes[1].maxHp = 20;

  applyDmEffects(state, { playerDamage: 10, causeOfDeath: 'упал в яму' }, 0);

  assert.equal(state.heroes[0].alive, false);
  assert.equal(state.over, false, 'второй герой ещё жив');
  assert.equal(state.activeIdx, 1, 'ход перешёл живому герою');
  assert.equal(state.heroes[state.activeIdx].alive, true);
});

test('DM ранил не активного героя — очередь не дёргается', () => {
  const state = twoHeroGame();
  state.activeIdx = 0;
  state.heroes[1].hp = 2;
  applyDmEffects(state, { playerDamage: 10 }, 1);
  assert.equal(state.heroes[1].alive, false);
  assert.equal(state.activeIdx, 0);
});

test('хост: выбывший по таймауту герой не блокирует ход партии', async () => {
  const net = createLoopbackNet();
  const host = createHostSession({ net: net.host, hostName: 'Дима', turnMs: 0, graceMs: 30 });
  const link = net.spawnClient();
  const client = createClientSession({ link, name: 'Катя' });
  client.hello();
  await tick();

  host.startGame({ worldDesc: 'Тьма', mode: 'sandbox', classAssignments: [HERO, HERO2], intro: null });
  await tick();

  const game = host.getGame();
  assert.equal(game.heroes.length, 2);

  // ход у клиента — и клиент пропадает навсегда
  game.activeIdx = 1;
  link.close();
  await tick(80);

  assert.equal(game.heroes[1].alive, false, 'герой выбыл после льготного времени');
  assert.equal(game.activeIdx, 0, 'очередь вернулась к живому герою');
  assert.equal(game.over, false);
  host.stop();
});

// ---------- сеть ----------

test('hybrid: оба канала не поднялись — отказ, а не вечное «создаём комнату»', async () => {
  await assert.rejects(
    firstSuccess([Promise.resolve(null), Promise.resolve(null)]),
    /ни один транспорт/
  );
  // один живой канал — победа, даже если второй упал
  assert.equal(await firstSuccess([Promise.resolve(null), Promise.resolve('p')]), 'p');
  assert.equal(await firstSuccess([Promise.resolve('t'), Promise.resolve(null)]), 't');
});

test('хост: падение ДМа не оставляет партию без ответа', async () => {
  const net = createLoopbackNet();
  const host = createHostSession({
    net: net.host, hostName: 'Дима', turnMs: 0,
    dm: { resolveFree: async () => { throw new Error('ключ протух'); } }
  });
  const link = net.spawnClient();
  const client = createClientSession({ link, name: 'Катя' });
  const events = [];
  client.onEvents(e => events.push(...e));
  client.hello();
  await tick();
  host.startGame({ worldDesc: 'Тьма', mode: 'sandbox', classAssignments: [HERO, HERO2], intro: null });
  await tick();

  host.localIntent('пытаюсь договориться с тьмой');
  await tick(30);

  const texts = events.map(e => e.text).join(' | ');
  assert.match(texts, /ДМ замолк/, 'игрок видит, что ДМ не ответил, а не тишину');
  host.stop();
});

test('хост: stop() закрывает транспорт, комната не висит призраком', async () => {
  let closed = 0;
  const net = createLoopbackNet();
  const netHost = { ...net.host, close() { closed++; } };
  const host = createHostSession({ net: netHost, hostName: 'Дима', turnMs: 0 });
  host.stop();
  assert.equal(closed, 1);
  assert.equal(host.getLobby().length, 1, 'в лобби остался только хост');
});

test('клиент: молчание хоста дольше лимита = потеря связи (heartbeat)', async () => {
  let closed = 0;
  const link = { sent: [], send(m) { this.sent.push(m); }, onMessage() {}, onClose(fn) { this._c = fn; }, close() {} };
  const client = createClientSession({ link, name: 'Катя', heartbeatMs: 15, staleMs: 40 });
  client.onClose(() => closed++);
  await tick(140);
  assert.equal(closed, 1, 'переподключение зовётся само');
  assert.ok(link.sent.some(m => m.t === 'ping'), 'клиент стучался к хосту');
  client.close();
});

test('клиент: живой хост (отвечает на ping) не считается мёртвым', async () => {
  let closed = 0;
  let deliver = null;
  const link = {
    sent: [],
    send(m) { this.sent.push(m); if (m.t === 'ping' && deliver) deliver({ t: 'pong' }); },
    onMessage(fn) { deliver = fn; },
    onClose() {},
    close() {}
  };
  const client = createClientSession({ link, name: 'Катя', heartbeatMs: 15, staleMs: 60 });
  client.onClose(() => closed++);
  await tick(150);
  assert.equal(closed, 0, 'pong держит соединение живым');
  client.close();
});

test('хост: вернувшийся игрок забирает слот, если старый сокет молчит', async () => {
  const net = createLoopbackNet();
  const host = createHostSession({ net: net.host, hostName: 'Дима', turnMs: 0, graceMs: 5000, staleMs: 20 });
  const l1 = net.spawnClient();
  const c1 = createClientSession({ link: l1, name: 'Катя' });
  c1.hello();
  await tick();

  host.startGame({ worldDesc: 'Тьма', mode: 'sandbox', classAssignments: [HERO, HERO2], intro: null });
  await tick();

  // сокет «Катя» не закрылся (полумёртвый), но молчит
  await tick(40);

  const l2 = net.spawnClient();
  const c2 = createClientSession({ link: l2, name: 'Катя' });
  let welcomed = null, rejected = null;
  c2.onWelcome(w => { welcomed = w; });
  c2.onReject(r => { rejected = r; });
  c2.hello(1);
  await tick(30);

  assert.equal(rejected, null, 'не отказ: слот отдан вернувшемуся');
  assert.ok(welcomed, 'пришёл welcome');
  assert.equal(welcomed.heroIdx, 1, 'тот же герой');
  assert.equal(welcomed.resumed, true);
  host.stop();
});

// ---------- сейв: id не должны пересекаться ----------

test('после загрузки сейва новые монстры получают свободные id', () => {
  const state = twoHeroGame();
  applyDmEffects(state, { enemySpawn: { name: 'тень', hp: 5 } });
  applyDmEffects(state, { enemySpawn: { name: 'тень-2', hp: 5 } });
  const before = state.monsters.map(m => m.id);

  const restored = deserializeRun(serializeRun(state));
  assert.ok(restored, 'сейв прочитался');
  applyDmEffects(restored, { enemySpawn: { name: 'новая тень', hp: 5 } });

  const ids = restored.monsters.map(m => m.id);
  assert.equal(new Set(ids).size, ids.length, 'id уникальны: ' + ids.join(','));
  assert.ok(!before.includes(ids.at(-1)), 'новый монстр не занял чужой id');
});

test('после загрузки сейва новые предметы получают свободные id', () => {
  const state = twoHeroGame();
  applyDmEffects(state, { itemGain: { name: 'Клинок', type: 'weapon', dmg: 3 } });
  applyDmEffects(state, { itemGain: { name: 'Щит', type: 'armor', ac: 1 } });

  const restored = deserializeRun(serializeRun(state));
  applyDmEffects(restored, { itemGain: { name: 'Кинжал', type: 'weapon', dmg: 2 } });

  const ids = restored.heroes.flatMap(h => h.inventory.map(i => i.id));
  assert.equal(new Set(ids).size, ids.length, 'id предметов уникальны: ' + ids.join(','));
});

test('сейв: recentRolls переживает сохранение', () => {
  const state = twoHeroGame();
  const mon = state.monsters[0];
  state.heroes[0].fov = new Set([`${mon.x},${mon.y}`]);
  applyIntent(state, { intent: 'attack', target: mon.name, raw: 'атакую' }, 0);
  assert.ok(state.recentRolls.length, 'броски записались');

  const restored = deserializeRun(serializeRun(state));
  assert.deepEqual(restored.recentRolls, state.recentRolls);
});

// ---------- кубики ----------

test('уровень: прибавка HP идёт из seeded-rng, а не из Math.random', () => {
  const mk = () => createPlayer({ name: 'Тест', className: 'Воин', stats: { str: 10, dex: 10, int: 10, con: 14, cha: 10, luck: 10 } });
  const a = mk(), b = mk();
  const r1 = createRng(777), r2 = createRng(777);
  gainXp(a, 500, r1);
  gainXp(b, 500, r2);
  assert.equal(a.level, b.level);
  assert.equal(a.maxHp, b.maxHp, 'одинаковый сид — одинаковый герой');
  assert.ok(a.level > 1, 'уровни реально выросли');
});

test('инициатива монстра не зависит от ловкости героя', () => {
  // раньше монстр бросал инициативу с dex героя: ловкий плут делал врагов быстрее.
  // Кубики подставные: d20 героя = 5, d20 монстра = 5. У героя dex 18 (мод +4):
  //   правильно — герой 9 против монстра 6 → бьёт герой;
  //   со старым багом — монстр 5+4+1 = 10 → бьёт монстр первым.
  const scripted = (values) => {
    let i = 0;
    return {
      check: (m) => { const raw = values[i++]; return { raw, total: raw + m }; },
      d20: () => values[i++],
      roll: (n) => ({ rolls: Array.from({ length: n }, () => 1), total: n }),
      d: () => 1
    };
  };
  const state = newGame({
    seed: 99, mode: 'sandbox', worldDesc: 'Тьма',
    players: [{ name: 'Х', className: 'К', stats: { str: 10, dex: 18, int: 10, con: 10, cha: 10, luck: 10 } }]
  });
  const hero = state.heroes[0];
  hero.hp = 999; hero.maxHp = 999;
  hero.equipment.weapon = makeItem({ name: 'меч', type: 'weapon', dmg: 3 });
  const mon = { id: 'mx', name: 'тень', x: hero.pos.x + 1, y: hero.pos.y, hp: 999, maxHp: 999, toHit: 1, dmg: 1, xp: 1 };

  const events = resolveCombatRound(state, hero, mon, scripted([5, 5, 18, 12, 18, 12]));
  const firstRoll = events.find(e => e.kind === 'roll');
  assert.ok(firstRoll, 'бросок был');
  assert.match(firstRoll.text, new RegExp(hero.name), 'первым бьёт герой, а не ускоренный его же ловкостью монстр');
});

test('дроп сохраняет finesse: кинжал бьёт от ловкости, а не от силы', () => {
  const item = makeItem({ name: 'Кинжал', type: 'weapon', dmg: 2, finesse: true });
  assert.equal(item.finesse, true);
  const dagger = BASIC_DROP_TABLE.find(e => e.item.name === 'Кинжал');
  assert.equal(dagger.item.finesse, true);
  const dropped = rollDrop({ d: () => 1, roll: () => ({ rolls: [], total: 1 }) }, [dagger], 1);
  assert.equal(dropped.finesse, true, 'finesse не теряется при создании предмета');
});
