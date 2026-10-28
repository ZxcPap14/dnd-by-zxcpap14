// loopback.js — in-memory сеть для хот-сита, тестов и отладки.
// Интерфейс хоста: broadcast/sendTo/onClientMessage/onClientJoin/onClientLeave.
// Интерфейс клиента: send/onMessage/onClose.

export function createLoopbackNet() {
  const clients = new Map(); // id → endpoint
  let seq = 0;
  let onMsg = null, onJoin = null, onLeave = null;

  const hostNet = {
    broadcast(msg) {
      for (const ep of clients.values()) queueMicrotask(() => ep._recv(msg));
    },
    sendTo(id, msg) {
      const ep = clients.get(id);
      if (ep) queueMicrotask(() => ep._recv(msg));
    },
    onClientMessage(cb) { onMsg = cb; },
    onClientJoin(cb) { onJoin = cb; },
    onClientLeave(cb) { onLeave = cb; }
  };

  return {
    host: hostNet,
    /** Создать клиентский эндпоинт. Возвращает link для ClientSession. */
    spawnClient() {
      const id = 'c' + (++seq);
      const ep = {
        id,
        _recv(msg) { if (ep._onMsg) ep._onMsg(msg); },
        send(msg) { queueMicrotask(() => { if (onMsg) onMsg(id, msg); }); },
        onMessage(fn) { ep._onMsg = fn; },
        onClose(fn) { ep._onClose = fn; },
        close() {
          if (clients.has(id)) {
            clients.delete(id);
            if (onLeave) queueMicrotask(() => onLeave(id));
          }
        }
      };
      clients.set(id, ep);
      if (onJoin) queueMicrotask(() => onJoin(id));
      return ep;
    },
    clientCount() { return clients.size; }
  };
}

/** Сгенерировать короткий код комнаты (без похожих символов). */
export function makeRoomCode(rng = Math.random) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += alphabet[Math.floor(rng() * alphabet.length)];
  return code;
}
