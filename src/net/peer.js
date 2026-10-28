// peer.js — оркестрация транспортов мультиплеера.
// РФ-плейтесты: 0.peerjs.com (signaling PeerJS) заблокирован без VPN, а публичные
// TURN-релеи часто недоступны из российских сетей — P2P умирает при живом сигналинге.
// Решение — тройная защита:
//   хост: регистрируется ПАРАЛЛЕЛЬНО на MQTT-транспорте (EMQX/HiveMQ, доступны из РФ)
//         и классическом PeerJS; живёт, пока работает хотя бы один.
//   клиент: 1) MQTT + WebRTC P2P (быстрый путь)
//           2) MQTT relay — игровой трафик через брокера (гарантированный путь)
//           3) PeerJS (за VPN / за пределами РФ)
// Игровой трафик в режимах 1 и 3 идёт P2P, в режиме 2 — через брокера.

import { ICE_SERVERS } from './ice.js';
import { createMqttHostNet, createMqttClientLink } from './webrtc.js';
import { netStatus } from './mqtt-signal.js';

const PEER_NAMESPACE = 'dndzxc14-';
const PEER_CDNS = [
  'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
  'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js'
];
const CONNECT_TIMEOUT_MS = 15000;
const JOIN_TIMEOUT_MS = 25000; // TURN-согласование через NAT занимает дольше
const REG_ATTEMPTS = 3;        // публичный брокер PeerJS бывает флакает — ретраим

const PEER_OPTS = {
  config: { iceServers: ICE_SERVERS, iceCandidatePoolSize: 10 },
  debug: 1
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Оверрайд MQTT-брокера из URL (?mqtt=ws://localhost:8080) — для локальных e2e. */
export function brokerOverride() {
  try { return new URLSearchParams(globalThis.location.search).get('mqtt') || undefined; } catch { return undefined; }
}

/** Оверрайд режима MQTT-линка из URL (?mqttmode=webrtc|relay) — для локальных e2e. */
export function mqttModeOverride() {
  try { return new URLSearchParams(globalThis.location.search).get('mqttmode') || 'auto'; } catch { return 'auto'; }
}

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

// ---------- Транспорт 2: классический PeerJS ----------

async function createPeerJsHostNet(code) {
  await loadPeerJS();
  const Peer = globalThis.Peer;

  const peer = await registerPeer(() =>
    new Peer(PEER_NAMESPACE + String(code).toLowerCase(), PEER_OPTS)
  );

  const conns = new Map();
  let onMsg = null, onJoin = null, onLeave = null;

  peer.on('connection', conn => {
    conns.set(conn.peer, conn);
    conn.on('data', msg => { if (onMsg) onMsg(conn.peer, msg); });
    conn.on('open', () => { if (onJoin) onJoin(conn.peer); });
    conn.on('close', () => { conns.delete(conn.peer); if (onLeave) onLeave(conn.peer); });
  });

  return {
    broadcast(msg) { conns.forEach(c => { if (c.open) c.send(msg); }); },
    sendTo(id, msg) { const c = conns.get(id); if (c && c.open) c.send(msg); },
    onClientMessage(cb) { onMsg = cb; },
    onClientJoin(cb) { onJoin = cb; },
    onClientLeave(cb) { onLeave = cb; },
    close() { peer.destroy(); }
  };
}

async function createPeerJsClientLink(code) {
  await loadPeerJS();
  const Peer = globalThis.Peer;

  // СНАЧАЛА ждём регистрации на signaling-брокере (с ретраями) —
  // peer.connect() до 'open' молча теряется (найдено e2e-тестом)
  const peer = await registerPeer(() => new Peer(PEER_OPTS));

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

// ---------- Оркестрация: хост на обоих транспортах, клиент — по цепочке ----------

function mergeNets(nets) {
  let onMsg = null, onJoin = null, onLeave = null;
  nets.forEach(n => {
    n.onClientMessage((id, m) => { if (onMsg) onMsg(id, m); });
    n.onClientJoin(id => { if (onJoin) onJoin(id); });
    n.onClientLeave(id => { if (onLeave) onLeave(id); });
  });
  return {
    broadcast(msg) { nets.forEach(n => n.broadcast(msg)); },
    sendTo(id, msg) { nets.forEach(n => n.sendTo(id, msg)); },
    onClientMessage(cb) { onMsg = cb; },
    onClientJoin(cb) { onJoin = cb; },
    onClientLeave(cb) { onLeave = cb; },
    close() { nets.forEach(n => n.close()); }
  };
}

/**
 * Сеть хоста: MQTT/WebRTC+релей (RF-путь) + PeerJS параллельно; живёт хотя бы один.
 */
export async function createPeerHostNet(code) {
  const opts = { brokerUrl: brokerOverride() };
  const results = await Promise.allSettled([
    createMqttHostNet(code, opts),
    createPeerJsHostNet(code)
  ]);
  const nets = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!nets.length) {
    const reasons = results.map(r => (r.reason && r.reason.message) || '?').join(' / ');
    throw new Error('Не удалось создать комнату: ' + reasons);
  }
  return nets.length === 1 ? nets[0] : mergeNets(nets);
}

/**
 * Линк клиента, цепочка попыток:
 *   1. MQTT + WebRTC P2P (быстрый путь)
 *   2. MQTT relay — трафик через брокера (гарантированный путь, если TURN мёртв)
 *   3. PeerJS (работает за VPN / за пределами РФ)
 */
export async function createPeerClientLink(code) {
  const opts = { brokerUrl: brokerOverride() };
  const mode = mqttModeOverride(); // auto | webrtc | relay
  const errs = [];

  if (mode !== 'relay') {
    try {
      netStatus({ stage: 'attempt', via: 'mqtt-webrtc' });
      return await createMqttClientLink(code, { ...opts, mode: 'webrtc' });
    } catch (e) {
      errs.push(e.message);
      netStatus({ stage: 'attempt-failed', via: 'mqtt-webrtc', error: e.message });
      if (mode === 'webrtc') throw e;
    }
  }
  if (mode !== 'webrtc') {
    try {
      netStatus({ stage: 'attempt', via: 'mqtt-relay' });
      return await createMqttClientLink(code, { ...opts, mode: 'relay' });
    } catch (e) {
      errs.push(e.message);
      netStatus({ stage: 'attempt-failed', via: 'mqtt-relay', error: e.message });
    }
  }
  try {
    netStatus({ stage: 'attempt', via: 'peerjs' });
    return await createPeerJsClientLink(code);
  } catch (peerErr) {
    // room-not-found — самый полезный ответ (хост действительно нигде не живёт)
    netStatus({ stage: 'attempt-failed', via: 'peerjs', error: peerErr.message });
    if (peerErr.peerType === 'peer-unavailable') throw peerErr;
    throw new Error('Не удалось подключиться: ' + [...errs, peerErr.message].filter(Boolean).join(' / '));
  }
}
