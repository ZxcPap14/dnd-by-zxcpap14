// trystero.js — WebRTC-транспорт поверх Trystero (публичные Nostr-релеи).
// Зачем: 0.peerjs.com в РФ заблокирован, и кооп без VPN не работал вообще.
// Trystero «знакомит» игроков через децентрализованную сеть релеев —
// единой точки отказа (одного сервера) нет.
//
// Интерфейс 1:1 как у peer.js, поэтому host.js/client.js о нём не знают.

const TRYSTERO_CDNS = [
  'https://cdn.jsdelivr.net/npm/trystero@0.26.0/+esm',
  'https://esm.run/trystero@0.26.0'
];
const TRYSTERO_APP_ID = 'dnd-zxcpap14';
const ROOM_PREFIX = 'dndzxc14-';
const RELAY_WAIT_MS = 14000; // сколько ждём первый живой релей
// сколько клиент ищет хоста. В HAR реальной игры answer от хоста шёл по релеям
// ~10 секунд — запас на медленные релеи + 2-3 попытки ICE (trystero ретраит
// соединение на каждом реанонсе)
const HOST_WAIT_MS = 20000;
const ANNOUNCE_MS = 1200;    // как часто клиент напоминает о себе

import { iceServers } from './turnconfig.js';

// Префикс tSleep, а не sleep: build.mjs склеивает модули в одну область,
// и одинаковые имена (как const sleep в peer.js) роняют весь бандл.
const tSleep = ms => new Promise(r => setTimeout(r, ms));

let trysteroPromise = null;

/** Ленивая загрузка Trystero с CDN (два зеркала — одно может быть заблокировано). */
export function loadTrystero() {
  if (trysteroPromise) return trysteroPromise;
  trysteroPromise = (async () => {
    for (const url of TRYSTERO_CDNS) {
      try {
        const mod = await import(url);
        if (mod && typeof mod.joinRoom === 'function') return mod;
      } catch { /* пробуем следующее зеркало */ }
    }
    throw new Error('Не удалось загрузить сетевой модуль (CDN недоступен)');
  })();
  return trysteroPromise;
}

function roomConfig() {
  return {
    appId: TRYSTERO_APP_ID,
    rtcConfig: { iceServers: iceServers(), iceCandidatePoolSize: 10 }
  };
}

/** Ждём хотя бы один открытый сокет релея: без него нас никто не найдёт. */
async function waitForRelay(getRelaySockets, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const socks = getRelaySockets ? getRelaySockets() : null;
      if (socks && Object.values(socks).some(s => s && s.readyState === 1)) return true;
    } catch { /* ignore */ }
    await tSleep(250);
  }
  return false;
}

/**
 * Сеть хоста поверх Trystero.
 * Интерфейс: { broadcast, sendTo, onClientMessage, onClientJoin, onClientLeave, close }
 */
export async function createTrysteroHostNet(code) {
  const T = await loadTrystero();
  const room = T.joinRoom(roomConfig(), ROOM_PREFIX + String(code).toLowerCase());

  // 'hi' — рукопожатие ролей, 'msg' — полезная нагрузка игры
  const hi = room.makeAction('hi');
  const msg = room.makeAction('msg');

  const clients = new Set();
  let onMsg = null, onJoin = null, onLeave = null;

  hi.onMessage = (data, ctx) => {
    if (!data || data.r !== 'c') return;
    // клиент мог не услышать 'h' из onPeerJoin (гонка при открытии канала) —
    // дублируем ответ на каждый стук, клиент игнорирует повторы сам
    try { hi.send({ r: 'h' }, { target: ctx.peerId }); } catch { /* ignore */ }
    if (clients.has(ctx.peerId)) return;
    clients.add(ctx.peerId);
    if (onJoin) onJoin(ctx.peerId);
  };
  msg.onMessage = (data, ctx) => {
    if (onMsg && clients.has(ctx.peerId)) onMsg(ctx.peerId, data);
  };

  room.onPeerJoin = id => {
    // сразу объявляем себя хостом — клиенту не придётся гадать
    try { hi.send({ r: 'h' }, { target: id }); } catch { /* ignore */ }
  };
  room.onPeerLeave = id => {
    if (clients.delete(id) && onLeave) onLeave(id);
  };

  const relayOk = await waitForRelay(T.getRelaySockets, RELAY_WAIT_MS);
  if (!relayOk) {
    try { await room.leave(); } catch { /* ignore */ }
    throw new Error('Релеи Trystero недоступны — сеть блокирует подключение');
  }

  return {
    broadcast(m) { try { msg.send(m); } catch { /* ignore */ } },
    sendTo(id, m) { try { msg.send(m, { target: id }); } catch { /* ignore */ } },
    onClientMessage(cb) { onMsg = cb; },
    onClientJoin(cb) { onJoin = cb; },
    onClientLeave(cb) { onLeave = cb; },
    close() { try { room.leave(); } catch { /* ignore */ } }
  };
}

/**
 * Линк клиента поверх Trystero. Ищет в комнате того, кто назвался хостом.
 * Интерфейс: { send, onMessage, onClose, close }
 */
export async function createTrysteroClientLink(code, { hostWaitMs = HOST_WAIT_MS } = {}) {
  const T = await loadTrystero();
  const roomId = ROOM_PREFIX + String(code).toLowerCase();

  // Trystero сам репортит провал ICE после обмена SDP («could not connect to
  // peer X after exchanging SDP»). Это точный диагноз «сигналинг прошёл,
  // но NAT/TURN не пробился» — не путаем его с «хост не найден».
  let natFailed = false;
  const room = T.joinRoom(roomConfig(), roomId, {
    onJoinError: ({ error } = {}) => {
      if (typeof error === 'string' && error.includes('after exchanging SDP')) natFailed = true;
    }
  });

  const hi = room.makeAction('hi');
  const msg = room.makeAction('msg');

  let hostId = null, onMsg = null, onClose = null, closed = false;

  const bail = () => {
    if (closed) return;
    closed = true;
    try { room.leave(); } catch { /* ignore */ }
    if (onClose) onClose();
  };

  hi.onMessage = (data, ctx) => {
    if (data && data.r === 'h' && !hostId) hostId = ctx.peerId;
  };
  msg.onMessage = (data, ctx) => {
    if (onMsg && hostId && ctx.peerId === hostId) onMsg(data);
  };
  room.onPeerJoin = () => announce();
  room.onPeerLeave = id => { if (id === hostId) bail(); };

  function announce() {
    try { hi.send({ r: 'c' }); } catch { /* ignore */ }
  }
  announce();

  // Ждём ответа хоста. Два исхода различаются сообщением:
  //  notfound — в комнате никого (опечатка в коде) — PeerJS-фолбэк имеет смысл
  //  nat      — пир найден и SDP обменялись, но ICE не пробился. PeerJS здесь
  //             не поможет: ICE-серверы те же — нужен VPN или свой TURN
  const t0 = Date.now();
  while (!hostId) {
    await tSleep(ANNOUNCE_MS);
    if (hostId) break;
    announce();
    if (Date.now() - t0 >= hostWaitMs) break;
  }
  if (!hostId) {
    bail();
    const err = new Error(natFailed
      ? 'хост найден, но P2P-канал не пробился через NAT'
      : 'Хост не найден в комнате за ' + Math.round(hostWaitMs / 1000) + ' с');
    if (natFailed) err.natFail = true; // гибрид сразу пойдёт на релей, без PeerJS
    throw err;
  }

  return {
    send(m) {
      if (closed) return;
      try { msg.send(m, { target: hostId }); } catch { /* ignore */ }
    },
    onMessage(cb) { onMsg = cb; },
    onClose(cb) { onClose = cb; },
    close() {
      closed = true;
      try { room.leave(); } catch { /* ignore */ }
    },
    transport: 'trystero'
  };
}
