// webrtc.js — MQTT-транспорты мультиплеера: один хост-нет, два режима клиента.
// РФ-плейтест: 0.peerjs.com заблокирован без VPN, а TURN-релеи часто недоступны
// из российских сетей → P2P WebRTC не пробивается, хотя сигналинг проходит.
//
// Архитектура (одна MQTT-связка на хоста):
//   1. host-here (retained) — присутствие хоста на рандеву-топике
//   2. режим 'webrtc': сигналинг offer/answer/ice через MQTT, трафик P2P
//   3. режим 'relay': ГАРАНТИРОВАННЫЙ фолбэк — весь игровой трафик через
//      MQTT-брокера (крошечные JSON-сообщения, публичные брокеры позволяют)
// Игровой протокол поверх не меняется: те же {broadcast, sendTo, ...} интерфейсы.

import { ICE_SERVERS } from './ice.js';
import { connectMqttBroker, roomTopic, clientTopic, parseEnvelope } from './mqtt-signal.js';

const randId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('');

/** Очередь ICE-кандидатов до setRemoteDescription (trickle может приходить раньше answer). */
function makeIceQueue(pc) {
  const pending = [];
  return {
    add(c) { if (pc.remoteDescription) pc.addIceCandidate(c).catch(() => { /* ignore */ }); else pending.push(c); },
    flush() { pending.splice(0).forEach(c => pc.addIceCandidate(c).catch(() => { /* ignore */ })); }
  };
}

/**
 * Сеть хоста через MQTT: принимает и WebRTC-клиентов (offer→DataChannel),
 * и релейных (relay-hello→сообщения через брокера). Один hostId на всё.
 */
export async function createMqttHostNet(code, { brokerUrl } = {}) {
  const mqttClient = await connectMqttBroker(brokerUrl);
  const hostId = 'h-' + randId();
  const room = roomTopic(code);
  const relayClients = new Set();
  const webrtcConns = new Map(); // clientId -> { pc, channel, iceQ }
  let onMsg = null, onJoin = null, onLeave = null;

  const sendToTopic = (topic, env, opts) => mqttClient.publish(topic, JSON.stringify({ ...env, from: hostId }), opts);
  const send = (toId, env) => sendToTopic(clientTopic(toId), env);
  const toRoom = (env, opts) => sendToTopic(room, env, opts);

  function leaveClient(id) {
    const e = webrtcConns.get(id);
    if (e) { try { e.channel && e.channel.close(); } catch { /* ignore */ } try { e.pc && e.pc.close(); } catch { /* ignore */ } }
    const wasWeb = webrtcConns.delete(id);
    const wasRelay = relayClients.delete(id);
    if ((wasWeb || wasRelay) && onLeave) onLeave(id);
  }

  function wireChannel(id, ch) {
    const e = webrtcConns.get(id);
    if (!e) return;
    e.channel = ch;
    ch.onmessage = ev => {
      if (!onMsg) return;
      try { onMsg(id, JSON.parse(ev.data)); } catch { onMsg(id, ev.data); }
    };
    ch.onopen = () => { if (onJoin) onJoin(id); };
    ch.onclose = () => leaveClient(id);
  }

  async function handleOffer(from, payload) {
    if (webrtcConns.has(from)) return;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry = { pc, iceQ: makeIceQueue(pc), channel: null };
    webrtcConns.set(from, entry);
    pc.ondatachannel = ev => wireChannel(from, ev.channel);
    pc.onicecandidate = ev => { if (ev.candidate) send(from, { kind: 'ice', candidate: ev.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) leaveClient(from);
    };
    await pc.setRemoteDescription(payload);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send(from, { kind: 'answer', payload: pc.localDescription });
    entry.iceQ.flush();
  }

  mqttClient.subscribe(room, () => {
    toRoom({ kind: 'host-here', ts: Date.now() }, { retain: true });
  });

  mqttClient.on('message', async (topic, raw) => {
    if (topic !== room) return;
    const env = parseEnvelope(raw.toString());
    if (!env || env.from === hostId) return;
    try {
      switch (env.kind) {
        case 'offer': await handleOffer(env.from, env.payload); break;
        case 'ice': { const e = webrtcConns.get(env.from); if (e) e.iceQ.add(env.candidate); break; }
        case 'relay-hello': if (!relayClients.has(env.from)) { relayClients.add(env.from); if (onJoin) onJoin(env.from); } break;
        case 'relay-msg': if (relayClients.has(env.from) && onMsg) onMsg(env.from, env.msg); break;
        case 'relay-bye': case 'bye': leaveClient(env.from); break;
      }
    } catch { /* битый envelope — игнор */ }
  });

  return {
    broadcast(msg) {
      webrtcConns.forEach(e => { if (e.channel && e.channel.readyState === 'open') e.channel.send(JSON.stringify(msg)); });
      if (relayClients.size) toRoom({ kind: 'relay-msg', msg });
    },
    sendTo(id, msg) {
      const e = webrtcConns.get(id);
      if (e && e.channel && e.channel.readyState === 'open') e.channel.send(JSON.stringify(msg));
      else if (relayClients.has(id)) send(id, { kind: 'relay-msg', msg });
    },
    onClientMessage(cb) { onMsg = cb; },
    onClientJoin(cb) { onJoin = cb; },
    onClientLeave(cb) { onLeave = cb; },
    close() {
      try { toRoom({ kind: 'relay-bye' }); } catch { /* ignore */ }
      try { mqttClient.publish(room, '', { retain: true }); } catch { /* ignore */ } // снять retained-присутствие
      [...webrtcConns.keys()].forEach(leaveClient);
      relayClients.clear();
      try { mqttClient.end(true); } catch { /* ignore */ }
    }
  };
}

/**
 * Линк клиента через MQTT. mode: 'webrtc' (P2P, приоритет) | 'relay' (через брокера).
 */
export async function createMqttClientLink(code, { brokerUrl, mode = 'webrtc', hostWaitMs = 12000, webrtcMs = 18000 } = {}) {
  const myId = 'c-' + randId();
  const room = roomTopic(code);
  const myTopic = clientTopic(myId);

  // LWT: если соединение клиента умрёт — брокер сам скажет хосту «relay-bye»
  const mqttClient = await connectMqttBroker(brokerUrl, {
    will: { topic: room, payload: JSON.stringify({ kind: 'relay-bye', from: myId }), qos: 0, retain: false }
  });

  let hostId = null;
  let onClose = null;

  // 1) ждём host-here (retained приходит сразу после subscribe, либо живой)
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('host-wait-timeout')), hostWaitMs);
      const onPresence = (topic, raw) => {
        const env = parseEnvelope(raw.toString());
        if (env && env.kind === 'host-here' && env.from !== myId) { clearTimeout(t); hostId = env.from; resolve(); }
      };
      mqttClient.on('message', onPresence);
      mqttClient.subscribe([room, myTopic], () => { /* retained может прийти уже тут */ });
    });
  } catch {
    mqttClient.end(true);
    const err = new Error('Хост не вышел на связь через MQTT-канал — возможно, комната не существует или хост на старой версии игры');
    err.peerType = 'no-host';
    throw err;
  }

  // 2а) relay-режим: трафик через брокера
  if (mode === 'relay') {
    let closed = false;
    let downTimer = null;
    const cleanup = () => {
      closed = true; clearTimeout(downTimer);
      try { mqttClient.publish(room, JSON.stringify({ kind: 'relay-bye', from: myId })); } catch { /* ignore */ }
      try { mqttClient.end(true); } catch { /* ignore */ }
    };
    // mqtt.js сам переподключается; если связь не вернулась за 12с — линк мёртв
    mqttClient.on('close', () => {
      if (closed) return;
      clearTimeout(downTimer);
      downTimer = setTimeout(() => { if (!closed) { closed = true; if (onClose) onClose(); } }, 12000);
    });
    mqttClient.on('connect', () => clearTimeout(downTimer));

    mqttClient.publish(room, JSON.stringify({ kind: 'relay-hello', from: myId }));

    // буфер: хост отвечает мгновенно, а onMessage регистрируется чуть позже
    const pending = [];
    let delivering = false;

    return {
      send(msg) { if (!closed) mqttClient.publish(room, JSON.stringify({ kind: 'relay-msg', from: myId, msg })); },
      onMessage(cb) {
        delivering = true;
        pending.splice(0).forEach(cb);
        mqttClient.on('message', (topic, raw) => {
          if (topic !== room && topic !== myTopic) return;
          const env = parseEnvelope(raw.toString());
          if (!env || env.from !== hostId || env.kind !== 'relay-msg') return;
          if (delivering) cb(env.msg); else pending.push(env.msg);
        });
      },
      onClose(cb) { onClose = cb; },
      close() { if (!closed) cleanup(); }
    };
  }

  // 2б) webrtc-режим: сигналинг через MQTT, трафик P2P
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const iceQ = makeIceQueue(pc);
  const dc = pc.createDataChannel('game', { ordered: true });

  pc.onicecandidate = ev => {
    if (ev.candidate) mqttClient.publish(clientTopic(hostId), JSON.stringify({ kind: 'ice', candidate: ev.candidate.toJSON(), from: myId }));
  };

  let onMsg = null;
  const cleanup = () => { try { dc.close(); } catch { /* ignore */ } try { pc.close(); } catch { /* ignore */ } try { mqttClient.end(true); } catch { /* ignore */ } };

  dc.onmessage = ev => { if (onMsg) { try { onMsg(JSON.parse(ev.data)); } catch { onMsg(ev.data); } } };
  dc.onclose = () => { if (onClose) onClose(); };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) { if (onClose) onClose(); }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  mqttClient.publish(room, JSON.stringify({ kind: 'offer', payload: pc.localDescription, from: myId }));

  mqttClient.on('message', async (topic, raw) => {
    if (topic !== myTopic) return;
    const env = parseEnvelope(raw.toString());
    if (!env || env.from !== hostId) return;
    try {
      if (env.kind === 'answer' && env.payload) { await pc.setRemoteDescription(env.payload); iceQ.flush(); }
      else if (env.kind === 'ice' && env.candidate) iceQ.add(env.candidate);
    } catch { /* ignore */ }
  });

  try {
    await Promise.race([
      new Promise(res => { if (dc.readyState === 'open') res(); else dc.onopen = res; }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('webrtc-timeout')), webrtcMs))
    ]);
  } catch {
    cleanup();
    const err = new Error('P2P-канал не пробился — переключаюсь на резервный канал');
    err.peerType = 'webrtc-timeout';
    throw err;
  }

  return {
    send(msg) { if (dc.readyState === 'open') dc.send(JSON.stringify(msg)); },
    onMessage(cb) { onMsg = cb; },
    onClose(cb) { onClose = cb; },
    close() { try { mqttClient.publish(room, JSON.stringify({ kind: 'bye', from: myId })); } catch { /* ignore */ } cleanup(); }
  };
}
