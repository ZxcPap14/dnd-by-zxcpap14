// peer.js — WebRTC-транспорт поверх PeerJS (ленивая загрузка с CDN).
// Хост: принимает несколько подключений. Клиент: один линк к хосту.
// Room code → namespaced peer-id на публичном signaling-брокере.

import { iceServers } from './turnconfig.js';

const PEER_NAMESPACE = 'dndzxc14-';
const PEER_CDNS = [
  'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
  'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js'
];
const CONNECT_TIMEOUT_MS = 15000;
const JOIN_TIMEOUT_MS = 25000; // TURN-согласование через NAT занимает дольше
const REG_ATTEMPTS = 3;        // публичный брокер PeerJS бывает флакает — ретраим

// ICE-серверы общие с trystero.js (turnconfig.js): STUN + пользовательский TURN.
// Бесплатный публичный TURN «Open Relay» закрылся (домен отдаёт фейковые адреса),
// поэтому без вписанного в настройках TURN соединение между разными сетями за
// строгим NAT/CGNAT умирает (сигналинг проходит, P2P — нет; найдено HAR-логом).
const PEER_OPTS = () => ({
  config: { iceServers: iceServers(), iceCandidatePoolSize: 10 },
  debug: 1
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Человекочитаемый текст для типа ошибки PeerJS (экспортируется для тестов). */
export function describePeerError(type, extra) {
  switch (type) {
    case 'network':
      return 'Сигнальный сервер недоступен (проблема сети или он перегружен). Подожди 20–30 секунд и попробуй ещё раз.';
    case 'server-error':
      return 'Сигнальный сервер временно сбоит. Подожди 20–30 секунд и попробуй ещё раз.';
    case 'unavailable-id':
      return 'Такой код комнаты уже занят — создай комнату с другим кодом.';
    case 'peer-unavailable':
      return 'Комната не найдена — проверь код.';
    case 'browser-incompatible':
      return 'Браузер не поддерживает WebRTC.';
    case 'timeout':
      return (extra ? 'Сигнальный сервер не отвечает: ' + extra + '.' : 'Сигнальный сервер не отвечает.') + ' Проверь интернет и попробуй ещё раз.';
    default:
      return 'Ошибка сети: ' + type;
  }
}

function peerError(e) {
  const type = (e && e.type) || (e && e.message) || 'unknown';
  const err = new Error(describePeerError(type));
  err.peerType = type;
  return err;
}

export function loadPeerJS() {
  if (globalThis.Peer) return Promise.resolve();
  let i = 0;
  return new Promise((resolve, reject) => {
    const tryNext = () => {
      if (i >= PEER_CDNS.length) {
        reject(new Error('Не удалось загрузить PeerJS — проверь интернет'));
        return;
      }
      const s = document.createElement('script');
      s.src = PEER_CDNS[i++];
      s.onload = () => { if (globalThis.Peer) resolve(); else tryNext(); };
      s.onerror = () => tryNext();
      document.head.appendChild(s);
    };
    tryNext();
  });
}

/**
 * Регистрация пира на signaling-брокере с ретраями.
 * Публичный брокер PeerJS (0.peerjs.com) нередко отдаёт network/server-error —
 * поэтому до REG_ATTEMPTS попыток с нарастающей паузой.
 */
async function registerPeer(makePeer, { timeout = CONNECT_TIMEOUT_MS, attempts = REG_ATTEMPTS } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(1000 * i);
    const peer = makePeer();
    try {
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(peerError({ type: 'timeout', message: 'timeout' })), timeout);
        peer.on('open', () => { clearTimeout(t); res(); });
        peer.on('error', e => { clearTimeout(t); rej(peerError(e)); });
      });
      return peer;
    } catch (e) {
      lastErr = e;
      try { peer.destroy(); } catch { /* ignore */ }
      // бессмысленно ретраить занятый id или несовместимый браузер
      if (e.peerType === 'unavailable-id' || e.peerType === 'browser-incompatible') throw e;
    }
  }
  throw lastErr;
}

/**
 * Сеть хоста. Интерфейс: { broadcast, sendTo, onClientMessage, onClientJoin, onClientLeave, close }
 */
export async function createPeerHostNet(code) {
  await loadPeerJS();
  const Peer = globalThis.Peer;

  const peer = await registerPeer(() =>
    new Peer(PEER_NAMESPACE + String(code).toLowerCase(), PEER_OPTS())
  );

  const conns = new Map();
  let onMsg = null, onJoin = null, onLeave = null;

  peer.on('connection', conn => {
    conns.set(conn.peer, conn);
    conn.on('data', msg => { if (onMsg) onMsg(conn.peer, msg); });
    conn.on('open', () => { if (onJoin) onJoin(conn.peer); });
    // 'error' без обработчика оставлял мёртвый сокет в conns: onLeave не срабатывал,
    // игрок не уходил в «ждём возвращения», а герой висел в комнате вечно
    const drop = () => {
      if (!conns.has(conn.peer)) return;
      conns.delete(conn.peer);
      if (onLeave) onLeave(conn.peer);
    };
    conn.on('close', drop);
    conn.on('error', drop);
  });

  return {
    broadcast(msg) { conns.forEach(c => { if (c.open) { try { c.send(msg); } catch { /* ignore */ } } }); },
    sendTo(id, msg) {
      const c = conns.get(id);
      if (c && c.open) { try { c.send(msg); } catch { /* ignore */ } }
    },
    onClientMessage(cb) { onMsg = cb; },
    onClientJoin(cb) { onJoin = cb; },
    onClientLeave(cb) { onLeave = cb; },
    close() {
      conns.forEach(c => { try { c.close(); } catch { /* ignore */ } });
      conns.clear();
      try { peer.destroy(); } catch { /* ignore */ }
    }
  };
}

/**
 * Линк клиента. Интерфейс: { send, onMessage, onClose, close }
 */
export async function createPeerClientLink(code) {
  await loadPeerJS();
  const Peer = globalThis.Peer;

  // СНАЧАЛА ждём регистрации на signaling-брокере (с ретраями) —
  // peer.connect() до 'open' молча теряется (найдено e2e-тестом)
  const peer = await registerPeer(() => new Peer(PEER_OPTS()));

  const conn = peer.connect(PEER_NAMESPACE + String(code).toLowerCase(), { reliable: true });
  let onMsg = null, onClose = null;

  conn.on('data', msg => { if (onMsg) onMsg(msg); });
  conn.on('close', () => { if (onClose) onClose(); });
  peer.on('error', () => { if (onClose) onClose(); });

  try {
    await Promise.race([
      new Promise((res, rej) => {
        conn.on('open', res);
        peer.on('error', e => {
          const type = e.type || '';
          if (type === 'peer-unavailable') rej(new Error(describePeerError('peer-unavailable')));
          else rej(peerError(e));
        });
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Хост не отвечает: проверь код и что хост ещё в лобби. Если сети не пробиваются через NAT — подожди 20 секунд и попробуй снова')), JOIN_TIMEOUT_MS))
    ]);
  } catch (e) {
    try { conn.close(); } catch { /* ignore */ }
    try { peer.destroy(); } catch { /* ignore */ }
    throw e;
  }

  return {
    send(msg) { if (conn.open) conn.send(msg); },
    onMessage(cb) { onMsg = cb; },
    onClose(cb) { onClose = cb; },
    close() { try { conn.close(); } catch { /*ignore*/ } try { peer.destroy(); } catch { /*ignore*/ } }
  };
}
