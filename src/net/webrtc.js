// webrtc.js — прямой WebRTC-транспорт поверх MQTT-сигналинга.
// Зачем: 0.peerjs.com заблокирован в РФ, а EMQX/HiveMQ (публичные MQTT-брокеры) — нет.
// MQTT несёт только рандеву (offer/answer/ICE); игровой трафик — P2P DataChannel.
// Интерфейсы повторяют peer.js: { broadcast, sendTo, onClientMessage, onClientJoin, onClientLeave, close }
// и { send, onMessage, onClose, close }.

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
 * Сеть хоста: слушает рандеву-топик комнаты, отвечает на offer'ы клиентов.
 */
export async function createWebRtcHostNet(code, { brokerUrl } = {}) {
  const mqttClient = await connectMqttBroker(brokerUrl);
  const hostId = 'h-' + randId();
  const room = roomTopic(code);
  const conns = new Map(); // clientId -> { pc, channel, iceQ }
  let onMsg = null, onJoin = null, onLeave = null;

  const send = (toId, env) => mqttClient.publish(clientTopic(toId), JSON.stringify({ ...env, from: hostId }));

  function teardown(id) {
    const e = conns.get(id);
    if (!e) return;
    conns.delete(id);
    try { if (e.channel) e.channel.close(); } catch { /* ignore */ }
    try { e.pc && e.pc.close(); } catch { /* ignore */ }
  }

  function wireChannel(id, ch) {
    const e = conns.get(id);
    if (!e) return;
    e.channel = ch;
    ch.onmessage = ev => {
      if (!onMsg) return;
      try { onMsg(id, JSON.parse(ev.data)); } catch { onMsg(id, ev.data); }
    };
    ch.onopen = () => { if (onJoin) onJoin(id); };
    ch.onclose = () => { teardown(id); if (onLeave) onLeave(id); };
  }

  async function handleOffer(from, payload) {
    let e = conns.get(from);
    if (!e) {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      e = { pc, iceQ: makeIceQueue(pc), channel: null };
      conns.set(from, e);
      pc.ondatachannel = ev => wireChannel(from, ev.channel);
      pc.onicecandidate = ev => { if (ev.candidate) send(from, { kind: 'ice', candidate: ev.candidate.toJSON() }); };
      pc.onconnectionstatechange = () => {
        if (['failed', 'closed'].includes(pc.connectionState)) { teardown(from); if (onLeave) onLeave(from); }
      };
    }
    await e.pc.setRemoteDescription(payload);
    const answer = await e.pc.createAnswer();
    await e.pc.setLocalDescription(answer);
    send(from, { kind: 'answer', payload: e.pc.localDescription });
    e.iceQ.flush();
  }

  mqttClient.subscribe(room, () => {
    // выход в эфир: retained, чтобы клиент мгновенно увидел хоста
    mqttClient.publish(room, JSON.stringify({ kind: 'host-here', from: hostId, ts: Date.now() }), { retain: true });
  });

  mqttClient.on('message', async (topic, raw) => {
    if (topic !== room) return;
    const env = parseEnvelope(raw.toString());
    if (!env || env.kind === 'host-here' || env.from === hostId) return;
    try {
      if (env.kind === 'offer' && env.payload) await handleOffer(env.from, env.payload);
      else if (env.kind === 'ice' && env.candidate && conns.get(env.from)) conns.get(env.from).iceQ.add(env.candidate);
      else if (env.kind === 'bye') { teardown(env.from); if (onLeave) onLeave(env.from); }
    } catch { /* битый envelope — игнор */ }
  });

  return {
    broadcast(msg) { conns.forEach(e => { if (e.channel && e.channel.readyState === 'open') e.channel.send(JSON.stringify(msg)); }); },
    sendTo(id, msg) { const e = conns.get(id); if (e && e.channel && e.channel.readyState === 'open') e.channel.send(JSON.stringify(msg)); },
    onClientMessage(cb) { onMsg = cb; },
    onClientJoin(cb) { onJoin = cb; },
    onClientLeave(cb) { onLeave = cb; },
    close() {
      try { mqttClient.publish(room, '', { retain: true }); } catch { /* ignore */ } // снять retained-присутствие
      conns.forEach((_, id) => teardown(id));
      try { mqttClient.end(true); } catch { /* ignore */ }
    }
  };
}

/**
 * Линк клиента: ждёт хоста на рандеву, делает offer, поднимает DataChannel.
 */
export async function createWebRtcClientLink(code, { brokerUrl, hostWaitMs = 12000, webrtcMs = 25000 } = {}) {
  const mqttClient = await connectMqttBroker(brokerUrl);
  const myId = 'c-' + randId();
  const room = roomTopic(code);
  const myTopic = clientTopic(myId);

  const send = env => mqttClient.publish(room, JSON.stringify({ ...env, from: myId }));
  const sendToHost = (hostId, env) => mqttClient.publish(clientTopic(hostId), JSON.stringify({ ...env, from: myId }));

  // 1) ждём host-here (retained приходит сразу после subscribe, либо живой)
  let hostId = null;
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('host-wait-timeout')), hostWaitMs);
      mqttClient.subscribe([room, myTopic], () => { /* retained host-here может прийти уже тут */ });
      const onMsg = (topic, raw) => {
        const env = parseEnvelope(raw.toString());
        if (env && env.kind === 'host-here' && env.from !== myId) { clearTimeout(t); hostId = env.from; resolve(); }
      };
      mqttClient.on('message', onMsg);
    });
  } catch {
    mqttClient.end(true);
    const err = new Error('Хост не вышел на связь через резервный канал (MQTT) — возможно, комната не существует или хост на старой версии игры');
    err.peerType = 'no-host';
    throw err;
  }

  // 2) offer → answer → DataChannel
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const iceQ = makeIceQueue(pc);
  const dc = pc.createDataChannel('game', { ordered: true });

  pc.onicecandidate = ev => { if (ev.candidate) sendToHost(hostId, { kind: 'ice', candidate: ev.candidate.toJSON() }); };

  let onMsg = null, onClose = null;
  const cleanup = () => { try { dc.close(); } catch { /* ignore */ } try { pc.close(); } catch { /* ignore */ } try { mqttClient.end(true); } catch { /* ignore */ } };

  dc.onmessage = ev => { if (onMsg) { try { onMsg(JSON.parse(ev.data)); } catch { onMsg(ev.data); } } };
  dc.onclose = () => { if (onClose) onClose(); };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) { if (onClose) onClose(); }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ kind: 'offer', payload: pc.localDescription });

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
    const err = new Error('Соединение с хостом не установилось (WebRTC не пробился) — попробуй ещё раз');
    err.peerType = 'webrtc-timeout';
    throw err;
  }

  return {
    send(msg) { if (dc.readyState === 'open') dc.send(JSON.stringify(msg)); },
    onMessage(cb) { onMsg = cb; },
    onClose(cb) { onClose = cb; },
    close() { try { sendToHost(hostId, { kind: 'bye' }); } catch { /* ignore */ } cleanup(); }
  };
}
