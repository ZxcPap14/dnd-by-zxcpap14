// hybrid.js — три транспорта.
// Хост поднимает И Trystero (Nostr-релеи), И PeerJS, И MQTT-релей: клиент найдёт
// его любым из трёх путей. Клиент: Trystero (P2P, быстрый) → MQTT-релей
// (работает через любой NAT) → PeerJS (на случай, если релей лежит).
//
// Идентификаторы клиентов префиксуются ('t:' / 'p:' / 'm:'), чтобы host.js не
// знал, по какому каналу пришёл игрок.

import { createTrysteroHostNet, createTrysteroClientLink } from './trystero.js';
import { createPeerHostNet, createPeerClientLink } from './peer.js';
import { createRelayHostNet, createRelayClientLink } from './relay.js';

/**
 * Первый успешно созданный транспорт.
 * ВАЖНО: фабрики не бросают — они возвращают null при неудаче. Если считать
 * только reject'ы, «оба канала не поднялись» никогда не разрешится и комната
 * будет вечно висеть на «Создаём комнату…». Поэтому null — тоже провал.
 */
export function firstSuccess(promises) {
  return new Promise((resolve, reject) => {
    let done = false;
    let settled = 0;
    const fail = () => {
      if (done) return;
      settled++;
      if (settled === promises.length) { done = true; reject(new Error('ни один транспорт не поднялся')); }
    };
    promises.forEach(p => {
      p.then(v => {
        if (done) return;
        if (v) { done = true; resolve(v); } else fail();
      }, fail);
    });
  });
}

const TRANSPORT_NAMES = { t: 'trystero', p: 'peerjs', m: 'relay' };

/**
 * Сеть хоста на всех транспортах.
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
  const relayP = tryNet('m', () => createRelayHostNet(code));

  let firstTag;
  try {
    firstTag = await firstSuccess([trysteroP, peerP, relayP]);
  } catch {
    throw new Error('Не удалось поднять ни один канал связи. ' + (errors.join('; ') || 'проверь интернет'));
  }

  return {
    transport: TRANSPORT_NAMES[firstTag] || firstTag,
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
 * Линк клиента: Trystero (8 с) → MQTT-релей → PeerJS.
 * Интерфейс: { send, onMessage, onClose, close, transport }
 */
export async function createHybridClientLink(code, onNote = null) {
  const errors = [];
  try {
    const link = await createTrysteroClientLink(code, { hostWaitMs: 8000 });
    if (onNote) onNote('канал: P2P (Trystero)');
    return link;
  } catch (e) {
    errors.push('trystero: ' + e.message);
    // NAT не пробился — релей как раз для этого случая. PeerJS не поможет:
    // у него те же ICE-серверы, а его облако сейчас отдаёт 403.
    if (onNote) onNote(e.natFail ? 'P2P не пробился — иду через релей…' : 'релеи не ответили — пробую MQTT-релей…');
  }
  try {
    const link = await createRelayClientLink(code);
    if (onNote) onNote('канал: MQTT-релей' + (link.broker ? ' (' + link.broker + ')' : ''));
    return link;
  } catch (e) {
    errors.push('relay: ' + e.message);
  }
  try {
    const link = await createPeerClientLink(code);
    if (onNote) onNote('канал: PeerJS');
    return link;
  } catch (e) {
    errors.push('peerjs: ' + e.message);
  }
  throw new Error(errors.join(' · '));
}
