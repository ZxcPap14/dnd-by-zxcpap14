// host.js — сессия хоста: лобби, очередь ходов, раздача снапшотов, таймер хода.
// Хост — всегда игрок 0. Движок и API-ключ живут здесь.
//
// Переподключение: если клиент потерял связь, его герой НЕ умирает сразу —
// он ждёт в «absent» (RECONNECT_GRACE_MS). Игрок возвращается по тому же коду
// и имени, хост узнаёт его и отдаёт снапшот с тем же heroIdx.

import { newGame, parseCommand, applyIntent, applyDmEffects, buildSnapshot, rememberEvents, advanceTurn } from '../engine/game.js';
import { stubDmTurn, resetStub } from '../ai/stub.js';
import { PROTOCOL_VER, TURN_MS, FREE_COOLDOWN_MS, SAY_COOLDOWN_MS, MAX_PLAYERS, RECONNECT_GRACE_MS } from './protocol.js';

/** Через сколько молчания игрока его слот можно отдать вернувшемуся (полумёртвый сокет). */
const STALE_MS = 20000;

/**
 * @param {object} opts
 * @param {object} opts.net  — { broadcast, sendTo, onClientMessage, onClientJoin, onClientLeave }
 * @param {string} opts.hostName
 * @param {object} [opts.dm] — { resolveFree(game, text, heroIdx) → Promise<effects>, intro(game) → Promise<effects> }
 * @param {number} [opts.turnMs] — таймер хода, 0 = выключен
 * @param {number} [opts.graceMs] — сколько герой ждёт вернувшегося игрока
 * @param {number} [opts.staleMs] — через сколько молчания слот считается брошенным
 */
export function createHostSession({ net, hostName, dm = null, turnMs = TURN_MS, graceMs = RECONNECT_GRACE_MS, staleMs = STALE_MS }) {
  const players = new Map();  // clientId → {id, name, heroIdx}
  const absent = new Map();   // name → {name, heroIdx, timer, since}
  let game = null;
  let started = false;
  let seq = 0;
  let turnTimer = null;
  const lastFree = new Map();
  const lastSay = new Map();
  const ui = { lobby: [], events: [], snapshot: [], over: [], absent: [] };

  const nextSeq = () => ++seq;

  function emit(key, payload) { ui[key].forEach(fn => { try { fn(payload); } catch { /* UI не роняет хост */ } }); }

  function lobbyList() {
    return [
      { id: 0, name: hostName, host: true },
      ...[...players.values()].map(p => ({ id: p.id, name: p.name, host: false })),
      ...[...absent.values()].map(a => ({ id: 'absent:' + a.name, name: a.name, host: false, offline: true }))
    ];
  }

  function broadcastLobby() {
    const msg = { t: 'lobby', ver: PROTOCOL_VER, players: lobbyList(), started };
    net.broadcast(msg);
    emit('lobby', msg.players);
    emit('absent', [...absent.values()].map(a => ({ name: a.name, heroIdx: a.heroIdx })));
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

  /** Герой окончательно потерян: умер по-английски. */
  function retireHero(heroIdx, name, reason) {
    if (!game || heroIdx == null) return;
    const hero = game.heroes[heroIdx];
    if (!hero || !hero.alive) return;
    hero.alive = false;
    hero.epitaph = reason;
    const events = [{ kind: 'death', text: `☠ ${hero.name} растворился в темноте (${name} так и не вернулся). Его снаряжение достаётся подземелью.` }];
    if (game.heroes.every(h => !h.alive)) {
      game.over = true;
      game.epitaph = hero.epitaph;
      events.push({ kind: 'death', text: '☠ Партия уничтожена.' });
    } else if (game.activeIdx === heroIdx) {
      // выбыл именно тот, чей ход, — иначе очередь навсегда застрянет на мёртвом
      advanceTurn(game);
    }
    broadcastEvents(events);
    armTurnTimer();
  }

  /** Поставить героя «на паузу» до возвращения игрока. */
  function holdHero(p) {
    if (!started || !game || p.heroIdx == null) return;
    const hero = game.heroes[p.heroIdx];
    if (!hero || !hero.alive) return;
    const name = p.name;
    const timer = setTimeout(() => {
      if (!absent.has(name)) return;
      absent.delete(name);
      broadcastLobby();
      retireHero(p.heroIdx, name, 'сбежал из подземелья по-английски');
    }, graceMs);
    if (typeof timer.unref === 'function') timer.unref(); // не держим процесс тестов живым
    absent.set(name, { name, heroIdx: p.heroIdx, timer, since: Date.now() });
    broadcastEvents([{
      kind: 'system',
      text: `⚡ ${name} потерял связь. Герой ждёт ${Math.round(graceMs / 1000)} сек — заходи по тому же коду, и он вернётся.`
    }]);
  }

  async function processIntent(heroIdx, command, cooldownKey, notifyId = null) {
    if (!game || !started || game.over) return;
    const notify = (events) => {
      const msg = { t: 'events', seq: nextSeq(), events };
      if (notifyId != null) net.sendTo(notifyId, msg);
      else emit('events', events);
    };
    const speaker = heroIdx != null ? game.heroes[heroIdx] : null;
    const intent = parseCommand(command, speaker?.ability?.name || null);

    // Реплика в чат партии: в любой момент, без очереди и без траты хода.
    // Это то, ради чего в коопе вообще нужен чат: договориться, не сжигая ход.
    if (intent.intent === 'say') {
      if (!speaker || !speaker.alive) return;
      const now = Date.now();
      if (now - (lastSay.get(cooldownKey) || 0) < SAY_COOLDOWN_MS) return;
      lastSay.set(cooldownKey, now);
      broadcastEvents(applyIntent(game, intent, heroIdx));
      return;
    }

    // эхо сообщения игрока — ВСЕМ: партия должна видеть, кто что написал
    if (speaker && command.trim()) {
      const echo = [{ kind: 'player', text: `${speaker.name}: ${command}` }];
      rememberEvents(game, echo); // ДМ тоже должен знать, КТО что делал
      net.broadcast({ t: 'events', seq: nextSeq(), events: echo });
      emit('events', echo);
    }
    // кулдаун на свободный текст — ДО проверки хода: он защищает ключ хоста
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
      notify([{ kind: 'system', text: 'Сейчас не твой ход — дождись очереди. (Но реплики в чат — «кричу …» — работают всегда.)' }]);
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
        // ДМ может упасть (сеть, ключ, кривой JSON) — партия не должна зависнуть молча
        let effects;
        try {
          effects = (dm && dm.resolveFree)
            ? await dm.resolveFree(game, text, heroIdx)
            : stubDmTurn(game, text);
        } catch (e) {
          effects = { narrative: `ДМ замолк (${e.message}). Тьма вежливо молчит.` };
        }
        events.push(...applyDmEffects(game, effects, heroIdx));
      }
    }
    broadcastEvents(events);
    armTurnTimer();
  }

  /** Вернуть потерявшегося игрока на его место. */
  function reattach(id, name) {
    const back = absent.get(name);
    if (!back) return false;
    clearTimeout(back.timer);
    absent.delete(name);
    players.set(id, { id, name: back.name, heroIdx: back.heroIdx });
    net.sendTo(id, { t: 'welcome', ver: PROTOCOL_VER, playerId: id, resumed: true, heroIdx: back.heroIdx, name: back.name });
    net.sendTo(id, { t: 'start', ver: PROTOCOL_VER, worldDesc: game.worldDesc, mode: game.mode, resumed: true });
    const snap = buildSnapshot(game, back.heroIdx);
    snap.seq = nextSeq();
    net.sendTo(id, snap);
    broadcastLobby();
    broadcastEvents([{ kind: 'system', text: `✦ ${back.name} вернулся в партию. Подземелье разочаровано.` }]);
    return true;
  }

  // ---- сетевые события ----
  net.onClientMessage(async (id, msg) => {
    try {
      const known = players.get(id);
      if (known) known.lastSeen = Date.now(); // жив ли сокет — видно по любым сообщениям
      if (msg.t === 'hello') {
        const wantName = String(msg.name || 'Игрок').slice(0, 16).trim() || 'Игрок';
        // 1) возвращение потерявшегося: имя совпало с тем, кто ждёт
        if (started && absent.has(wantName)) { reattach(id, wantName); return; }
        if (started) {
          // 2) тот же игрок с полумёртвым сокетом: старый вход молчит, слот отдаём
          const ghost = [...players.entries()].find(([pid, p]) => pid !== id && p.name === wantName && Date.now() - (p.lastSeen || 0) > staleMs);
          if (ghost) {
            players.delete(ghost[0]);
            absent.set(wantName, { name: wantName, heroIdx: ghost[1].heroIdx, timer: null, since: Date.now() });
            if (reattach(id, wantName)) return;
          }
          net.sendTo(id, { t: 'reject', reason: 'Игра уже началась. Если ты был в партии — вернись по тому же коду и имени.' });
          return;
        }
        if (msg.ver !== PROTOCOL_VER) { net.sendTo(id, { t: 'reject', reason: 'Разные версии игры — обнови страницу.' }); return; }
        if (players.size >= MAX_PLAYERS) { net.sendTo(id, { t: 'reject', reason: 'Комната полна (макс 4).' }); return; }
        const taken = new Set([hostName, ...[...players.values()].map(p => p.name)]);
        let name = wantName;
        if (taken.has(name)) name = name.slice(0, 13) + Math.floor(Math.random() * 90 + 10);
        players.set(id, { id, name, heroIdx: null, lastSeen: Date.now() });
        net.sendTo(id, { t: 'welcome', ver: PROTOCOL_VER, playerId: id, name });
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
    if (!p) return;
    players.delete(id);
    broadcastLobby();
    if (started && game && p.heroIdx != null && game.heroes[p.heroIdx]?.alive) {
      holdHero(p); // не убиваем сразу: игрок может вернуться
    }
  });

  // ---- публичный API ----
  return {
    /** Список лобби для UI */
    getLobby: lobbyList,
    isStarted: () => started,
    getGame: () => game,
    /** Кто сейчас ждёт переподключения. */
    getAbsent: () => [...absent.values()].map(a => ({ name: a.name, heroIdx: a.heroIdx, since: a.since })),

    /** Подписки UI хоста */
    onLobby(fn) { ui.lobby.push(fn); },
    onEvents(fn) { ui.events.push(fn); },
    onSnapshot(fn) { ui.snapshot.push(fn); },
    onOver(fn) { ui.over.push(fn); },
    onAbsent(fn) { ui.absent.push(fn); },

    /**
     * Старт игры. classAssignments: [{name, className, stats, ability}] для ВСЕЙ партии,
     * хост первый. intro — асинхронный эффект вступления (ИИ или заглушка).
     * backstory — отредактированная игроком предыстория (канон для ДМа).
     */
    startGame({ worldDesc, mode, classAssignments, backstory = '', intro = null }) {
      if (started) return;
      resetStub();
      for (const a of absent.values()) clearTimeout(a.timer);
      absent.clear();
      const playersCfg = classAssignments.map((c, i) => ({ ...c, name: i === 0 ? hostName : (players.get([...players.keys()][i - 1])?.name || c.name) }));
      game = newGame({
        seed: (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0,
        mode, worldDesc, players: playersCfg, backstory
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

    /**
     * Продолжить сохранённый забег в коопе: состояние уже готово, комната — та же.
     * Герои, кроме хоста, ждут переподключения по своим именам.
     */
    resumeGame(savedState) {
      if (started || !savedState) return false;
      resetStub();
      for (const a of absent.values()) clearTimeout(a.timer);
      absent.clear();
      game = savedState;
      started = true;
      for (let idx = 1; idx < game.heroes.length; idx++) {
        const hero = game.heroes[idx];
        if (!hero.alive) continue;
        const name = hero.name;
        const timer = setTimeout(() => {
          if (!absent.has(name)) return;
          absent.delete(name);
          broadcastLobby();
          retireHero(idx, name, 'сбежал из подземелья по-английски');
        }, graceMs);
        if (typeof timer.unref === 'function') timer.unref();
        absent.set(name, { name, heroIdx: idx, timer, since: Date.now() });
      }
      broadcastLobby();
      broadcastSnapshots();
      armTurnTimer();
      return true;
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
        retireHero(p.heroIdx, p.name, 'выгнан хостом');
      }
    },

    stop() {
      if (turnTimer) clearTimeout(turnTimer);
      for (const a of absent.values()) clearTimeout(a.timer);
      absent.clear();
      started = false;
      game = null;
      players.clear();
      // закрыть транспорт: иначе комната висит в релеях/брокере призраком,
      // а клиенты считают, что хост ещё жив
      try { net.close?.(); } catch { /* ignore */ }
    }
  };
}
