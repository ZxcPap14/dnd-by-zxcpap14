// relay.js — гарантированный канал через публичные MQTT-брокеры (WSS, порт 443).
// Зачем: P2P (Trystero/TURN) не пробивается через CGNAT и VPN, а игровой трафик
// тут крошечный (ходы + снапшот), поэтому брокер тянет его без проблем.
// Это НЕ замена P2P: hybrid.js пробует P2P первым, релей — фолбэк.
//
// Интерфейсы 1:1 с peer.js/trystero.js, host.js и client.js о канале не знают.

const RELAY_CDNS = [
  'https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js',
  'https://cdn.jsdelivr.net/npm/mqtt@5.10.1/dist/mqtt.min.js'
];

// Порядок важен только для хоста: клиент опрашивает все брокеры параллельно,
// иначе игроки оказываются на разных брокерах и никогда не встречаются.
export const RELAY_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt'
];

const BROKER_TIMEOUT_MS = 7000;
const PRESENCE_MS = 20000;       // как часто хост обновляет retained-присутствие
const PRESENCE_STALE_MS = 60000; // retained старше — хост давно мёртв
const CLIENT_SILENCE_MS = 45000; // молчание релейного клиента = отвалился
const HOST_SILENCE_MS = 65000;
const QOS = 1;
const NS = 'dndzxc14/v2';

export const roomTopic = code => `${NS}/r/${String(code).toLowerCase()}`;
const clientTopic = id => `${NS}/c/${id}`;

const relayId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('');

/** ?mqtt=ws://host:port (список через запятую) — оверрайд для локальных e2e. */
export function relayBrokerOverride() {
  try {
    const q = new URLSearchParams(globalThis.location.search);
    return q.get('mqtt') || q.get('relay') || undefined;
  } catch { return undefined; }
}

const RELAY_KEY = 'dnd-relay-v1';
let relayMemory = null; // в node (тесты) localStorage нет

/** Свой брокер, сохранённый в настройках («СЕТЬ»). Пустая строка — сброс. */
export function loadRelayUrl() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(RELAY_KEY) : relayMemory;
    return raw || '';
  } catch { return ''; }
}

export function saveRelayUrl(text) {
  const s = String(text || '').trim();
  const ok = !s || /^wss?:\/\/\S+$/.test(s);
  if (!ok) return { ok: false, error: 'Нужен адрес вида wss://relay.example.com/mqtt' };
  try {
    if (typeof localStorage !== 'undefined') {
      if (s) localStorage.setItem(RELAY_KEY, s); else localStorage.removeItem(RELAY_KEY);
    } else relayMemory = s;
  } catch { relayMemory = s; }
  return { ok: true, url: s };
}

function brokerList(custom) {
  const list = custom || relayBrokerOverride() || loadRelayUrl();
  if (list) return String(list).split(',').map(s => s.trim()).filter(Boolean);
  // В Node нет CDN-загрузчика, а публичные брокеры в юнит-тестах не нужны:
  // без явного brokerUrl релей считается недоступным и гибрид падает быстро.
  if (typeof document === 'undefined') throw new Error('MQTT-релей доступен только в браузере');
  return RELAY_BROKERS;
}

export function shortBroker(url) {
  try { return new URL(url).hostname.split('.').slice(-2).join('.'); } catch { return String(url); }
}

/** mqtt.js: в браузере — скрипт с CDN, в Node (тесты) — пакет из devDependencies. */
export function loadRelayMqtt() {
  if (globalThis.mqtt) return Promise.resolve();
  if (typeof document === 'undefined') {
    return import('mqtt').then(m => { globalThis.mqtt = m.default || m; });
  }
  let i = 0;
  return new Promise((resolve, reject) => {
    const tryNext = () => {
      if (i >= RELAY_CDNS.length) { reject(new Error('Не удалось загрузить MQTT-клиент — проверь интернет')); return; }
      const s = document.createElement('script');
      s.src = RELAY_CDNS[i++];
      s.onload = () => { if (globalThis.mqtt) resolve(); else tryNext(); };
      s.onerror = () => tryNext();
      document.head.appendChild(s);
    };
    tryNext();
  });
}

/** Валидация конверта: чужой мусор в публичном топике не должен ломать игру. */
export function parseRelayEnvelope(raw) {
  let env = raw;
  if (typeof raw === 'string' || raw instanceof Uint8Array) {
    try { env = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return null; }
  }
  if (!env || typeof env !== 'object') return null;
  if (!['host-here', 'hello', 'msg', 'ping', 'bye'].includes(env.kind)) return null;
  if (typeof env.from !== 'string' || !env.from) return null;
  if (env.kind === 'msg' && (!env.msg || typeof env.msg !== 'object')) return null;
  return env;
}

function connectOne(url, opts) {
  return new Promise((resolve, reject) => {
    let client;
    try {
      client = globalThis.mqtt.connect(url, {
        clientId: 'dnd-' + relayId(),
        connectTimeout: BROKER_TIMEOUT_MS,
        reconnectPeriod: 2000,
        keepalive: 30,
        clean: true,
        ...opts
      });
    } catch (e) { reject(e); return; }
    const t = setTimeout(() => { try { client.end(true); } catch { /* ignore */ } reject(new Error('timeout ' + url)); }, BROKER_TIMEOUT_MS);
    client.on('connect', () => { clearTimeout(t); resolve(client); });
    client.on('error', e => { clearTimeout(t); try { client.end(true); } catch { /* ignore */ } reject(e); });
  });
}

/** Первый подключившийся брокер; остальные соединения закрываем, не дожидаясь их. */
async function connectAny(urls) {
  await loadRelayMqtt();
  return new Promise((resolve, reject) => {
    let pending = urls.length, done = false, lastErr = null;
    urls.forEach(url => {
      connectOne(url).then(client => {
        if (done) {
          try { client.end(true); } catch { /* ignore */ }
          return;
        }
        done = true;
        resolve({ client, url });
      }).catch(e => {
        lastErr = e;
        if (--pending === 0 && !done) { done = true; reject(new Error('Ни один MQTT-брокер не ответил (' + (lastErr ? lastErr.message : 'нет сети') + ')')); }
      });
    });
  });
}

/** Подписки переживают reconnect: при clean:true mqtt.js теряет их после обрыва. */
function keepSubscribed(client, topics) {
  const set = new Set(topics);
  const sub = () => { if (set.size) client.subscribe([...set], { qos: QOS }); };
  client.on('connect', sub);
  return t => { set.add(t); client.subscribe([t], { qos: QOS }); };
}

/**
 * Сеть хоста через релей.
 * Интерфейс: { broadcast, sendTo, onClientMessage, onClientJoin, onClientLeave, close, transport }
 */
export async function createRelayHostNet(code, { brokerUrl } = {}) {
  const { client, url } = await connectAny(brokerList(brokerUrl));
  const room = roomTopic(code);
  const hostId = 'h-' + relayId();
  const subscribe = keepSubscribed(client, [room]);
  const relayClients = new Set();
  const lastSeen = new Map();
  const seenIds = new Set();
  const seenOrder = [];
  let onMsg = null, onJoin = null, onLeave = null;

  const publish = (topic, env, opts, cb) => client.publish(
    topic, JSON.stringify({ ...env, from: hostId }), { qos: QOS, ...opts }, cb);

  function leaveClient(id) {
    const was = relayClients.delete(id);
    lastSeen.delete(id);
    if (was && onLeave) onLeave(id);
  }

  function rememberId(id) {
    if (!id) return true;
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    seenOrder.push(id);
    if (seenOrder.length > 500) seenIds.delete(seenOrder.shift());
    return true;
  }

  const presence = () => publish(room, { kind: 'host-here', ts: Date.now() }, { retain: true });
  // Публичные брокеры рвут соединение и сами восстанавливают его через
  // mqtt.js — после переподключения retained-присутствие надо выложить сразу,
  // иначе клиент до следующего тика таймера видит устаревшую метку.
  client.on('connect', presence);
  subscribe(room);
  presence();
  const presenceTimer = setInterval(presence, PRESENCE_MS);

  const watchdog = setInterval(() => {
    const now = Date.now();
    for (const [id, ts] of lastSeen) if (now - ts > CLIENT_SILENCE_MS) leaveClient(id);
  }, 15000);

  client.on('message', (topic, raw) => {
    if (topic !== room) return;
    const env = parseRelayEnvelope(raw);
    if (!env || env.from === hostId) return;
    if (relayClients.has(env.from)) lastSeen.set(env.from, Date.now());
    try {
      switch (env.kind) {
        case 'hello':
          if (!relayClients.has(env.from)) {
            relayClients.add(env.from);
            lastSeen.set(env.from, Date.now());
            if (onJoin) onJoin(env.from);
          }
          break;
        case 'msg':
          if (relayClients.has(env.from) && rememberId(env.id) && onMsg) onMsg(env.from, env.msg);
          break;
        case 'ping': break;
        case 'bye': leaveClient(env.from); break;
      }
    } catch { /* битый конверт — игнор */ }
  });

  return {
    transport: 'relay',
    broadcast(msg) {
      if (relayClients.size) publish(room, { kind: 'msg', id: relayId(), msg });
    },
    sendTo(id, msg) {
      if (relayClients.has(id)) publish(clientTopic(id), { kind: 'msg', id: relayId(), msg });
    },
    onClientMessage(cb) { onMsg = cb; },
    onClientJoin(cb) { onJoin = cb; },
    onClientLeave(cb) { onLeave = cb; },
    broker: shortBroker(url),
    close() {
      clearInterval(presenceTimer);
      clearInterval(watchdog);
      // end(true) сразу после publish рвёт соединение до подтверждения QoS 1 —
      // клиенты тогда не узнают, что хост ушёл. Ждём ack, но не дольше 2 с.
      try {
        publish(room, { kind: 'bye' }, { retain: false }, () => { try { client.end(); } catch { /* ignore */ } });
        client.publish(room, '', { retain: true, qos: QOS });
        setTimeout(() => { try { client.end(true); } catch { /* ignore */ } }, 2000).unref?.();
      } catch { try { client.end(true); } catch { /* ignore */ } }
    }
  };
}

/** Ищем живой хост на всех брокерах сразу: первый, кто прислал свежий host-here. */
async function findHost(urls, room, myTopic, myId, timeoutMs) {
  await loadRelayMqtt();
  const attempts = urls.map(url => new Promise(resolve => {
    let settled = false, client;
    try {
      client = globalThis.mqtt.connect(url, {
        clientId: 'dnd-' + relayId(),
        connectTimeout: BROKER_TIMEOUT_MS,
        reconnectPeriod: 0,
        keepalive: 30,
        clean: true
      });
    } catch { resolve(null); return; }
    const done = (win) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!win) { try { client.end(true); } catch { /* ignore */ } }
      resolve(win ? { client, url, hostId: win.hostId } : null);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    client.on('connect', () => client.subscribe([room, myTopic], { qos: QOS }));
    client.on('message', (topic, raw) => {
      if (topic !== room) return;
      const env = parseRelayEnvelope(raw);
      if (!env || env.from === myId || env.kind !== 'host-here') return;
      // retained от давно закрытой комнаты не должен считаться живым хостом
      if (!env.ts || Date.now() - env.ts > PRESENCE_STALE_MS) return;
      done({ hostId: env.from });
    });
    client.on('error', () => done(null));
  }));

  return new Promise(resolve => {
    let winner = null, pending = attempts.length;
    attempts.forEach(p => p.then(r => {
      if (r && !winner) { winner = r; resolve(r); }
      else if (r) { try { r.client.end(true); } catch { /* ignore */ } }
      if (--pending === 0 && !winner) resolve(null);
    }));
  });
}

/**
 * Линк клиента через релей.
 * Интерфейс: { send, onMessage, onClose, close, transport }
 */
export async function createRelayClientLink(code, { brokerUrl, hostWaitMs = 10000 } = {}) {
  const myId = 'c-' + relayId();
  const room = roomTopic(code);
  const myTopic = clientTopic(myId);
  const urls = brokerList(brokerUrl);

  const found = await findHost(urls, room, myTopic, myId, hostWaitMs);
  if (!found) {
    const err = new Error('Хост не найден через релей (' + urls.map(shortBroker).join(', ') + ') — проверь код комнаты');
    err.relayNoHost = true;
    throw err;
  }

  const { client, url, hostId } = found;
  const subscribe = keepSubscribed(client, [room, myTopic]);
  let onMsg = null, onClose = null, closed = false;
  let lastHostMsg = Date.now();
  let downTimer = null;
  const pending = [];

  const fail = () => {
    if (closed) return;
    closed = true;
    clearInterval(pingTimer);
    clearInterval(hostTimer);
    clearTimeout(downTimer);
    try { client.end(true); } catch { /* ignore */ }
    if (onClose) onClose();
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(pingTimer);
    clearInterval(hostTimer);
    clearTimeout(downTimer);
    // как и у хоста: даём брокеру подтвердить bye, иначе на той стороне
    // игрок останется «в сети» до 45-секундного вотчдога
    try {
      client.publish(room, JSON.stringify({ kind: 'bye', from: myId }), { qos: QOS }, () => { try { client.end(); } catch { /* ignore */ } });
      setTimeout(() => { try { client.end(true); } catch { /* ignore */ } }, 2000).unref?.();
    } catch { try { client.end(true); } catch { /* ignore */ } }
  };

  const sendRaw = (env) => { try { client.publish(room, JSON.stringify({ ...env, from: myId }), { qos: QOS }); } catch { /* ignore */ } };
  const pingTimer = setInterval(() => sendRaw({ kind: 'ping' }), 10000);
  const hostTimer = setInterval(() => {
    if (Date.now() - lastHostMsg > HOST_SILENCE_MS) fail();
  }, 10000);

  client.on('message', (topic, raw) => {
    if (topic !== room && topic !== myTopic) return;
    const env = parseRelayEnvelope(raw);
    if (!env || env.from !== hostId) return;
    lastHostMsg = Date.now();
    if (env.kind === 'bye') { fail(); return; }
    if (env.kind !== 'msg') return;
    if (onMsg) onMsg(env.msg); else pending.push(env.msg);
  });

  // mqtt.js переподключается сам. После reconnect хост мог уже списать нас
  // из лобби по вотчдогу — поэтому заново здороваемся.
  client.on('connect', () => {
    clearTimeout(downTimer);
    sendRaw({ kind: 'hello' });
  });
  client.on('close', () => {
    if (closed) return;
    clearTimeout(downTimer);
    downTimer = setTimeout(() => { if (!closed && Date.now() - lastHostMsg > 12000) fail(); }, 12000);
  });

  sendRaw({ kind: 'hello' });

  return {
    transport: 'relay',
    broker: shortBroker(url),
    send(msg) { if (!closed) sendRaw({ kind: 'msg', id: relayId(), msg }); },
    onMessage(cb) {
      onMsg = cb;
      pending.splice(0).forEach(cb);
    },
    onClose(cb) { onClose = cb; },
    close() { cleanup(); }
  };
}
