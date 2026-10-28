// host.js — сессия хоста: лобби, очередь ходов, раздача снапшотов, таймер хода.
// Хост — всегда игрок 0. Движок и API-ключ живут здесь.

import { newGame, parseCommand, applyIntent, applyDmEffects, buildSnapshot, rememberEvents } from '../engine/game.js';
import { stubDmTurn, resetStub } from '../ai/stub.js';
import { PROTOCOL_VER, TURN_MS, FREE_COOLDOWN_MS, MAX_PLAYERS } from './protocol.js';

/**
 * @param {object} opts
 * @param {object} opts.net  — { broadcast, sendTo, onClientMessage, onClientJoin, onClientLeave }
 * @param {string} opts.hostName
 * @param {object} [opts.dm] — { resolveFree(game, text, heroIdx) → Promise<effects>, intro(game) → Promise<effects> }
 * @param {number} [opts.turnMs] — таймер хода, 0 = выключен
 */
export function createHostSession({ net, hostName, dm = null, turnMs = TURN_MS }) {
  const players = new Map(); // clientId → {id, name, heroIdx}
  let game = null;
  let started = false;
  let seq = 0;
  let turnTimer = null;
  const lastFree = new Map();
  const ui = { lobby: [], events: [], snapshot: [], over: [] };

  const nextSeq = () => ++seq;

  function emit(key, payload) { ui[key].forEach(fn => { try { fn(payload); } catch { /* UI не роняет хост */ } }); }

  function lobbyList() {
    return [
      { id: 0, name: hostName, host: true },
      ...[...players.values()].map(p => ({ id: p.id, name: p.name, host: false }))
    ];
  }

  function broadcastLobby() {
    const msg = { t: 'lobby', ver: PROTOCOL_VER, players: lobbyList(), started };
    net.broadcast(msg);
    emit('lobby', msg.players);
  }

  function idForHero(heroIdx) {
    for (const p of players.values()) if (p.heroIdx === heroIdx) return p.id;
    return null;
  }

  function broadcastEvents(events) {
    const clean = events
      .filter(e => e.kind !== 'dm' || !e.text.startsWith('__FREE__'))
      .map(e => ({ kind: e.kind, text: e.text }));
    if (clean.length) {
      net.broadcast({ t: 'events', seq: nextSeq(), events: clean });
      emit('events', clean);
    }
    if (game) {
      broadcastSnapshots();
      if (game.over) emit('over', { epitaph: game.epitaph });
    }
  }

  function broadcastSnapshots() {
    if (!game) return;
    for (let idx = 0; idx < game.heroes.length; idx++) {
      const snap = buildSnapshot(game, idx);
      snap.seq = nextSeq();
      if (idx === 0) emit('snapshot', snap);
      else {
        const id = idForHero(idx);
        if (id != null) net.sendTo(id, snap);
      }
    }
  }

  function armTurnTimer() {
    if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
    if (!turnMs || !game || game.over || game.heroes.length <= 1) return;
    turnTimer = setTimeout(() => {
      if (game && !game.over && started) {
        const events = applyIntent(game, { intent: 'wait' }, game.activeIdx);
        broadcastEvents(events);
      }
    }, turnMs);
  }

  async function processIntent(heroIdx, command, cooldownKey, notifyId = null) {
    if (!game || !started || game.over) return;
    const notify = (events) => {
      const msg = { t: 'events', seq: nextSeq(), events };
      if (notifyId != null) net.sendTo(notifyId, msg);
      else emit('events', events);
    };
    // эхо сообщения игрока — ВСЕМ: партия должна видеть, кто что написал
    const speaker = heroIdx != null ? game.heroes[heroIdx] : null;
    if (speaker && command.trim()) {
      const echo = [{ kind: 'player', text: `${speaker.name}: ${command}` }];
      rememberEvents(game, echo); // ДМ тоже должен знать, КТО что делал
      net.broadcast({ t: 'events', seq: nextSeq(), events: echo });
      emit('events', echo);
    }
    // кулдаун на свободный текст — ДО проверки хода: он защищает ключ хоста
    const intent = parseCommand(command);
    if (intent.intent === 'free') {
      const now = Date.now();
      const last = lastFree.get(cooldownKey) || 0;
      const wait = FREE_COOLDOWN_MS - (now - last);
      if (wait > 0) {
        notify([{ kind: 'system', text: `Слишком много вольностей подряд — ДМ переваривает. ${Math.ceil(wait / 1000)} сек.` }]);
        return;
      }
      lastFree.set(cooldownKey, now);
    }
    if (heroIdx !== game.activeIdx) {
      notify([{ kind: 'system', text: 'Сейчас не твой ход — дождись очереди.' }]);
      return;
    }
    let events = applyIntent(game, intent, heroIdx);
    // свободный текст → ДМ (в т.ч. перехваченные тупики движка — стена/нет предмета)
    for (const e of events) {
      if (e.kind === 'dm' && e.text.startsWith('__FREE__')) {
        const text = e.text.slice('__FREE__'.length);
        if (intent.intent !== 'free') {
          // тупик движка, переадресованный в свободный текст — тоже тратит лимит вольностей
          const now = Date.now();
          const wait = FREE_COOLDOWN_MS - (now - (lastFree.get(cooldownKey) || 0));
          if (wait > 0) {
            events.push({ kind: 'system', text: `Слишком много вольностей подряд — ДМ переваривает. ${Math.ceil(wait / 1000)} сек.`, turn: 0 });
            continue;
          }
          lastFree.set(cooldownKey, now);
        }
        const effects = (dm && dm.resolveFree)
          ? await dm.resolveFree(game, text, heroIdx)
          : stubDmTurn(game, text);
        events.push(...applyDmEffects(game, effects, heroIdx));
      }
    }
    broadcastEvents(events);
    armTurnTimer();
  }

  // ---- сетевые события ----
  net.onClientMessage(async (id, msg) => {
    try {
      if (msg.t === 'hello') {
        if (started) { net.sendTo(id, { t: 'reject', reason: 'Игра уже началась.' }); return; }
        if (msg.ver !== PROTOCOL_VER) { net.sendTo(id, { t: 'reject', reason: 'Разные версии игры — обнови страницу.' }); return; }
        if (players.size >= MAX_PLAYERS) { net.sendTo(id, { t: 'reject', reason: 'Комната полна (макс 4).' }); return; }
        const taken = new Set([hostName, ...[...players.values()].map(p => p.name)]);
        let name = String(msg.name || 'Игрок').slice(0, 16).trim() || 'Игрок';
        if (taken.has(name)) name = name.slice(0, 13) + Math.floor(Math.random() * 90 + 10);
        players.set(id, { id, name, heroIdx: null });
        net.sendTo(id, { t: 'welcome', ver: PROTOCOL_VER, playerId: id });
        broadcastLobby();
      } else if (msg.t === 'intent') {
        const p = players.get(id);
        await processIntent(p?.heroIdx, String(msg.command || '').slice(0, 200), id, id);
      } else if (msg.t === 'ping') {
        net.sendTo(id, { t: 'pong' });
      }
    } catch { /* мусор от клиента не роняет хост */ }
  });

  net.onClientLeave(id => {
    const p = players.get(id);
    players.delete(id);
    broadcastLobby();
    if (started && game && p && p.heroIdx != null && game.heroes[p.heroIdx]?.alive) {
      const hero = game.heroes[p.heroIdx];
      hero.alive = false;
      hero.epitaph = 'сбежал из подземелья по-английски';
      const events = [{
        kind: 'death',
        text: `☠ ${hero.name} растворился в темноте (вышел из игры). Его снаряжение достаётся подземелью.`
      }];
      if (game.heroes.every(h => !h.alive)) {
        game.over = true;
        game.epitaph = hero.epitaph;
        events.push({ kind: 'death', text: '☠ Партия уничтожена.' });
      }
      broadcastEvents(events);
    }
  });

  // ---- публичный API ----
  return {
    /** Список лобби для UI */
    getLobby: lobbyList,
    isStarted: () => started,
    getGame: () => game,

    /** Подписки UI хоста */
    onLobby(fn) { ui.lobby.push(fn); },
    onEvents(fn) { ui.events.push(fn); },
    onSnapshot(fn) { ui.snapshot.push(fn); },
    onOver(fn) { ui.over.push(fn); },

    /**
     * Старт игры. classAssignments: [{name, className, stats}] для ВСЕЙ партии,
     * хост первый. intro — асинхронный эффект вступления (ИИ или заглушка).
     */
    startGame({ worldDesc, mode, classAssignments, intro = null }) {
      if (started) return;
      resetStub();
      const playersCfg = classAssignments.map((c, i) => ({ ...c, name: i === 0 ? hostName : (players.get([...players.keys()][i - 1])?.name || c.name) }));
      game = newGame({
        seed: (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0,
        mode, worldDesc, players: playersCfg
      });
      let i = 1;
      for (const p of players.values()) p.heroIdx = i++;
      started = true;
      net.broadcast({ t: 'start', ver: PROTOCOL_VER, worldDesc, mode });
      broadcastLobby();
      broadcastSnapshots();
      if (intro) {
        Promise.resolve(intro(game))
          .then(effects => broadcastEvents(applyDmEffects(game, effects, 0)))
          .catch(() => broadcastEvents(applyDmEffects(game, { narrative: 'ДМ не отвечает. Ты очнулся в темноте. Как обычно.' }, 0)));
      }
      armTurnTimer();
    },

    /** Ход игрока-хоста (heroIdx 0). resolveFree подключается так же, как для клиентов. */
    localIntent(command) {
      return processIntent(0, command, 'host');
    },

    /** Пуш эффектов ДМа извне (интро, события хоста). */
    pushDmEffects(effects, heroIdx = 0) {
      if (!game) return;
      broadcastEvents(applyDmEffects(game, effects, heroIdx));
    },

    /** Пуш системного события всем. */
    pushSystem(text) {
      broadcastEvents([{ kind: 'system', text }]);
    },

    kick(id, reason = 'Хост выгнал тебя. Бывает.') {
      const p = players.get(id);
      if (!p) return;
      net.sendTo(id, { t: 'kicked', reason });
      players.delete(id);
      broadcastLobby();
      if (started && game && p.heroIdx != null && game.heroes[p.heroIdx]?.alive) {
        const hero = game.heroes[p.heroIdx];
        hero.alive = false;
        hero.epitaph = 'выгнан хостом';
        broadcastEvents([{ kind: 'death', text: `☠ ${hero.name} изгнан. ${reason}` }]);
      }
    },

    stop() {
      if (turnTimer) clearTimeout(turnTimer);
      started = false;
      game = null;
    }
  };
}
