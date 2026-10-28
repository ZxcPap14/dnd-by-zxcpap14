// hybrid.js — два транспорта одновременно.
// Хост поднимает И Trystero (Nostr-релеи), И PeerJS: клиент найдёт его любым
// из двух путей. Клиент сначала пробует Trystero (работает в РФ без VPN),
// при неудаче — PeerJS (работает через VPN и в сетях, где релеи закрыты).
//
// Идентификаторы клиентов префиксуются ('t:' / 'p:'), чтобы host.js не знал,
// по какому каналу пришёл игрок.

import { createTrysteroHostNet, createTrysteroClientLink } from './trystero.js';
import { createPeerHostNet, createPeerClientLink } from './peer.js';

/** Первый успешно созданный транспорт (null-и — неудачи, их пропускаем). */
function firstSuccess(promises) {
  return new Promise((resolve, reject) => {
    let failed = 0;
    let done = false;
    promises.forEach(p => {
      p.then(v => {
        if (done) return;
        if (v) { done = true; resolve(v); }
      }, () => {
        if (done) return;
        if (++failed === promises.length) { done = true; reject(new Error('ни один транспорт не поднялся')); }
      });
    });
  });
}

/**
 * Сеть хоста на обоих транспортах.
 * Интерфейс: { broadcast, sendTo, onClientMessage, onClientJoin, onClientLeave, close, transport }
 */
export async function createHybridHostNet(code) {
  const nets = [];       // [{ tag, net }]
  const errors = [];
  let onMsg = null, onJoin = null, onLeave = null;

  function attach(tag, net) {
    net.onClientMessage((raw, msg) => { if (onMsg) onMsg(tag + ':' + raw, msg); });
    net.onClientJoin(raw => { if (onJoin) onJoin(tag + ':' + raw); });
    net.onClientLeave(raw => { if (onLeave) onLeave(tag + ':' + raw); });
    nets.push({ tag, net });
  }

  const tryNet = (tag, factory) => factory()
    .then(net => { attach(tag, net); return tag; })
    .catch(e => { errors.push(`${tag}: ${e.message}`); return null; });

  const trysteroP = tryNet('t', () => createTrysteroHostNet(code));
  const peerP = tryNet('p', () => createPeerHostNet(code));

  let firstTag;
  try {
    firstTag = await firstSuccess([trysteroP, peerP]);
  } catch {
    throw new Error('Не удалось поднять ни один канал связи. ' + (errors.join('; ') || 'проверь интернет'));
  }

  return {
    transport: firstTag === 't' ? 'trystero' : 'peerjs',
    broadcast(m) { nets.forEach(({ net }) => { try { net.broadcast(m); } catch { /* ignore */ } }); },
    sendTo(id, m) {
      const i = String(id).indexOf(':');
      if (i < 0) return;
      const tag = id.slice(0, i), raw = id.slice(i + 1);
      const hit = nets.find(n => n.tag === tag);
      if (hit) { try { hit.net.sendTo(raw, m); } catch { /* ignore */ } }
    },
    onClientMessage(cb) { onMsg = cb; },
    onClientJoin(cb) { onJoin = cb; },
    onClientLeave(cb) { onLeave = cb; },
    /** Список поднятых каналов — для диагностики в UI и e2e. */
    channels() { return nets.map(n => n.tag); },
    close() { nets.forEach(({ net }) => { try { net.close(); } catch { /* ignore */ } }); }
  };
}

/**
 * Линк клиента: Trystero первым, PeerJS как запасной путь.
 * Интерфейс: { send, onMessage, onClose, close, transport }
 */
export async function createHybridClientLink(code, onNote = null) {
  const errors = [];
  try {
    const link = await createTrysteroClientLink(code);
    if (onNote) onNote('канал: релеи (Trystero)');
    return link;
  } catch (e) {
    errors.push('trystero: ' + e.message);
    if (onNote) onNote('релеи не ответили — пробуем PeerJS…');
  }
  try {
    const link = await createPeerClientLink(code);
    if (onNote) onNote('канал: PeerJS');
    return link;
  } catch (e) {
    errors.push('peerjs: ' + e.message);
  }
  throw new Error(`Не удалось подключиться. ${errors.join(' · ')}`);
}
