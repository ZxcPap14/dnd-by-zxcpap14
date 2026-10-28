// peer.js — WebRTC-транспорт поверх PeerJS (ленивая загрузка с CDN).
// Хост: принимает несколько подключений. Клиент: один линк к хосту.
// Room code → namespaced peer-id на публичном signaling-брокере.

const PEER_NAMESPACE = 'dndzxc14-';
const PEER_CDN = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
const CONNECT_TIMEOUT_MS = 15000;

export function loadPeerJS() {
  if (globalThis.Peer) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PEER_CDN;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Не удалось загрузить PeerJS — нужна сеть для мультиплеера'));
    document.head.appendChild(s);
  });
}

/**
 * Сеть хоста. Интерфейс: { broadcast, sendTo, onClientMessage, onClientJoin, onClientLeave, close }
 */
export async function createPeerHostNet(code) {
  await loadPeerJS();
  const Peer = globalThis.Peer;
  const peer = new Peer(PEER_NAMESPACE + String(code).toLowerCase());
  const conns = new Map();
  let onMsg = null, onJoin = null, onLeave = null;

  peer.on('connection', conn => {
    conns.set(conn.peer, conn);
    conn.on('data', msg => { if (onMsg) onMsg(conn.peer, msg); });
    conn.on('open', () => { if (onJoin) onJoin(conn.peer); });
    conn.on('close', () => { conns.delete(conn.peer); if (onLeave) onLeave(conn.peer); });
  });

  await Promise.race([
    new Promise((res, rej) => {
      peer.on('open', res);
      peer.on('error', e => rej(new Error('PeerJS: ' + (e.type || e.message))));
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Signaling-брокер не отвечает — попробуй ещё раз')), CONNECT_TIMEOUT_MS))
  ]);

  return {
    broadcast(msg) { conns.forEach(c => { if (c.open) c.send(msg); }); },
    sendTo(id, msg) { const c = conns.get(id); if (c && c.open) c.send(msg); },
    onClientMessage(cb) { onMsg = cb; },
    onClientJoin(cb) { onJoin = cb; },
    onClientLeave(cb) { onLeave = cb; },
    close() { peer.destroy(); }
  };
}

/**
 * Линк клиента. Интерфейс: { send, onMessage, onClose, close }
 */
export async function createPeerClientLink(code) {
  await loadPeerJS();
  const Peer = globalThis.Peer;
  const peer = new Peer();

  // СНАЧАЛА ждём регистрации на signaling-брокере — peer.connect() до 'open'
  // молча теряется (найдено e2e-тестом: таймаут «хост не отвечает»)
  await Promise.race([
    new Promise((res, rej) => {
      peer.on('open', res);
      peer.on('error', e => rej(new Error('PeerJS: ' + (e.type || e.message))));
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Signaling-брокер не отвечает')), CONNECT_TIMEOUT_MS))
  ]);

  const conn = peer.connect(PEER_NAMESPACE + String(code).toLowerCase(), { reliable: true });
  let onMsg = null, onClose = null;

  conn.on('data', msg => { if (onMsg) onMsg(msg); });
  conn.on('close', () => { if (onClose) onClose(); });
  peer.on('error', () => { if (onClose) onClose(); });

  await Promise.race([
    new Promise((res, rej) => {
      conn.on('open', res);
      peer.on('error', e => {
        const type = e.type || '';
        if (type === 'peer-unavailable') rej(new Error('Комната не найдена — проверь код'));
        else rej(new Error('PeerJS: ' + (type || e.message)));
      });
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Хост не отвечает — проверь код комнаты')), CONNECT_TIMEOUT_MS))
  ]);

  return {
    send(msg) { if (conn.open) conn.send(msg); },
    onMessage(cb) { onMsg = cb; },
    onClose(cb) { onClose = cb; },
    close() { try { conn.close(); } catch { /*ignore*/ } try { peer.destroy(); } catch { /*ignore*/ } }
  };
}
