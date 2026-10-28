// client.js — клиентская сессия: тонкий терминал. Держит link (send/onMessage/onClose).

import { PROTOCOL_VER } from './protocol.js';

/**
 * @param {object} opts
 * @param {object} opts.link — { send(msg), onMessage(cb), onClose(cb), close() }
 * @param {string} opts.name
 */
export function createClientSession({ link, name }) {
  let myId = null;
  let lastSeq = 0;
  let closed = false;
  const cbs = {
    welcome: [], lobby: [], events: [], snapshot: [], start: [],
    reject: [], kicked: [], close: []
  };

  function emit(key, payload) { cbs[key].forEach(fn => { try { fn(payload); } catch { /* ignore */ } }); }

  link.onMessage(msg => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'welcome':
        myId = msg.playerId;
        emit('welcome', { playerId: msg.playerId });
        break;
      case 'reject':
        emit('reject', { reason: msg.reason });
        break;
      case 'kicked':
        emit('kicked', { reason: msg.reason });
        break;
      case 'lobby':
        emit('lobby', msg.players);
        break;
      case 'start':
        emit('start', { worldDesc: msg.worldDesc, mode: msg.mode });
        break;
      case 'events':
        if (typeof msg.seq === 'number' && msg.seq <= lastSeq) return; // дубликат/устаревшее
        if (typeof msg.seq === 'number') lastSeq = msg.seq;
        emit('events', msg.events || []);
        break;
      case 'snapshot':
        if (typeof msg.seq === 'number' && msg.seq < lastSeq - 1) return;
        if (typeof msg.seq === 'number') lastSeq = Math.max(lastSeq, msg.seq);
        emit('snapshot', msg);
        break;
      case 'pong':
      default:
        break;
    }
  });

  link.onClose(() => {
    if (!closed) { closed = true; emit('close', {}); }
  });

  return {
    hello() { link.send({ t: 'hello', ver: PROTOCOL_VER, name }); },
    sendCommand(text) { if (!closed) link.send({ t: 'intent', command: String(text).slice(0, 200) }); },
    ping() { link.send({ t: 'ping' }); },
    getId: () => myId,
    close() { closed = true; link.close(); },
    onWelcome(fn) { cbs.welcome.push(fn); },
    onLobby(fn) { cbs.lobby.push(fn); },
    onEvents(fn) { cbs.events.push(fn); },
    onSnapshot(fn) { cbs.snapshot.push(fn); },
    onStart(fn) { cbs.start.push(fn); },
    onReject(fn) { cbs.reject.push(fn); },
    onKicked(fn) { cbs.kicked.push(fn); },
    onClose(fn) { cbs.close.push(fn); }
  };
}
